import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Diagnostic } from "../diagnostics.ts";
import { parse } from "../parser/parse.ts";
import type {
  Block,
  ClassDecl,
  Expr,
  FunctionDecl,
  InterfaceDecl,
  Program,
  Span,
  Statement,
  TypeAlias,
  TypeMember,
  TypeNode,
  VarStmt,
} from "../parser/ast.ts";
import {
  ERROR_TYPE,
  arrayType,
  excludeType,
  functionType,
  getProperty,
  intersectNarrow,
  isAssignable,
  isNever,
  isNonProductiveAliasBody,
  isUnknown,
  isVoid,
  objectType,
  optionalReadType,
  prim,
  propertyNames,
  refType,
  substitute,
  typeToString,
  typesOverlap,
  unionType,
  unwrap,
  type FnParamType,
  type PropType,
  type Type,
  type TypeDef,
} from "./types.ts";

export type CheckOptions = {
  readFile?: (absolutePath: string) => string | null;
};

type BindingKind = "value" | "type" | "both";

type Binding = {
  name: string;
  kind: BindingKind;
  mutable: boolean;
  valueType: Type;
  typeDef?: TypeDef;
};

type Scope = {
  bindings: Map<string, Binding>;
  parent: Scope | null;
};

type NarrowMap = Map<string, Type>;

type ModuleResult = {
  namedValues: Map<string, Binding>;
  namedTypes: Map<string, Binding>;
  defaultExport: Binding | null;
  /** Diagnostics originating in this module only. */
  diagnostics: Diagnostic[];
  parseFailed: boolean;
};

type CheckerContext = {
  file: string;
  diagnostics: Diagnostic[];
  readFile: (absolutePath: string) => string | null;
  moduleCache: Map<string, ModuleResult>;
  checkingStack: Set<string>;
  scope: Scope;
  narrowing: NarrowMap;
  returnType: Type | null;
  thisType: Type | null;
  inExprStmt: boolean;
};

function defaultReadFile(absolutePath: string): string | null {
  try {
    return readFileSync(absolutePath, "utf8");
  } catch {
    return null;
  }
}

function diag(
  ctx: CheckerContext,
  code: string,
  message: string,
  span: Span | null,
  hint?: string,
): void {
  const d: Diagnostic = {
    code,
    severity: "error",
    message,
    file: ctx.file,
  };
  if (span !== null) {
    d.start = span.start;
    d.end = span.end;
  }
  if (hint !== undefined) d.hint = hint;
  ctx.diagnostics.push(d);
}

function pushScope(ctx: CheckerContext): void {
  ctx.scope = { bindings: new Map(), parent: ctx.scope };
}

function popScope(ctx: CheckerContext): void {
  if (ctx.scope.parent !== null) ctx.scope = ctx.scope.parent;
}

function lookupBinding(ctx: CheckerContext, name: string): Binding | null {
  let scope: Scope | null = ctx.scope;
  while (scope !== null) {
    const b = scope.bindings.get(name);
    if (b !== undefined) return b;
    scope = scope.parent;
  }
  return null;
}

function lookupValueType(ctx: CheckerContext, name: string): Type | null {
  const narrowed = ctx.narrowing.get(name);
  if (narrowed !== undefined) return narrowed;
  const b = lookupBinding(ctx, name);
  if (b === null || b.kind === "type") return null;
  return b.valueType;
}

function declareInScope(
  ctx: CheckerContext,
  binding: Binding,
  span: Span,
): void {
  if (ctx.scope.bindings.has(binding.name)) {
    diag(
      ctx,
      "jsv.check.duplicate_declaration",
      `Duplicate declaration of '${binding.name}'.`,
      span,
    );
    return;
  }
  ctx.scope.bindings.set(binding.name, binding);
}

function consoleType(): Type {
  return objectType([
    {
      name: "log",
      optional: false,
      type: functionType([], prim("void"), [], true),
    },
    {
      name: "error",
      optional: false,
      type: functionType([], prim("void"), [], true),
    },
  ]);
}

function withNarrowing<T>(
  ctx: CheckerContext,
  extra: NarrowMap,
  fn: () => T,
): T {
  if (extra.size === 0) return fn();
  const prev = ctx.narrowing;
  const merged = new Map(prev);
  for (const [k, v] of extra) merged.set(k, v);
  ctx.narrowing = merged;
  try {
    return fn();
  } finally {
    ctx.narrowing = prev;
  }
}

// --- Type resolution --------------------------------------------------------

function resolveTypeMembers(
  ctx: CheckerContext,
  members: TypeMember[],
  typeParamNames: Set<string>,
): PropType[] {
  const props: PropType[] = [];
  for (const m of members) {
    if (m.kind === "prop") {
      props.push({
        name: m.name,
        optional: m.optional,
        type: resolveTypeNode(ctx, m.type, typeParamNames),
      });
    } else {
      const tpNames = m.typeParams.map((t) => t.name);
      const inner = new Set([...typeParamNames, ...tpNames]);
      props.push({
        name: m.name,
        optional: false,
        type: functionType(
          m.params.map((p) => ({
            name: p.name,
            type: resolveTypeNode(ctx, p.type, inner),
          })),
          resolveTypeNode(ctx, m.returnType, inner),
          tpNames,
        ),
      });
    }
  }
  return props;
}

function resolveTypeNode(
  ctx: CheckerContext,
  node: TypeNode,
  typeParamNames: Set<string> = new Set(),
): Type {
  switch (node.kind) {
    case "prim":
      return prim(node.name);
    case "array":
      return arrayType(resolveTypeNode(ctx, node.element, typeParamNames));
    case "union":
      return unionType(
        node.types.map((t) => resolveTypeNode(ctx, t, typeParamNames)),
      );
    case "object":
      return objectType(resolveTypeMembers(ctx, node.members, typeParamNames));
    case "function":
      return functionType(
        node.params.map((p) => ({
          name: p.name,
          type: resolveTypeNode(ctx, p.type, typeParamNames),
        })),
        resolveTypeNode(ctx, node.returnType, typeParamNames),
      );
    case "named": {
      if (typeParamNames.has(node.name) && node.args.length === 0) {
        return { kind: "type_param", name: node.name };
      }
      const binding = lookupBinding(ctx, node.name);
      if (
        binding === null ||
        binding.kind === "value" ||
        binding.typeDef === undefined
      ) {
        if (binding !== null && binding.kind === "value") {
          diag(
            ctx,
            "jsv.check.value_as_type",
            `'${node.name}' refers to a value, but is used as a type.`,
            node.nameSpan,
          );
        } else {
          diag(
            ctx,
            "jsv.check.unresolved_name",
            `Unresolved name '${node.name}'.`,
            node.nameSpan,
          );
        }
        return ERROR_TYPE;
      }
      const def = binding.typeDef;
      if (def.typeParams.length > 0 && node.args.length === 0) {
        diag(
          ctx,
          "jsv.check.missing_type_arguments",
          `Type '${node.name}' requires type arguments.`,
          node.span,
        );
        return ERROR_TYPE;
      }
      if (node.args.length !== def.typeParams.length) {
        diag(
          ctx,
          "jsv.check.type_argument_count",
          `Expected ${def.typeParams.length} type argument(s), got ${node.args.length}.`,
          node.span,
        );
        return ERROR_TYPE;
      }
      const args = node.args.map((a) =>
        resolveTypeNode(ctx, a, typeParamNames),
      );
      return refType(def, args);
    }
    default: {
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}

function expectedObjectType(expected: Type | null): Extract<
  Type,
  { kind: "object" }
> | null {
  if (expected === null) return null;
  const t = unwrap(expected);
  if (t.kind === "object") return t;
  if (t.kind === "union") {
    for (const m of t.members) {
      const u = unwrap(m);
      if (u.kind === "object") return u;
    }
  }
  return null;
}

function expectedArrayElement(expected: Type | null): Type | null {
  if (expected === null) return null;
  const t = unwrap(expected);
  if (t.kind === "array") return t.element;
  if (t.kind === "union") {
    for (const m of t.members) {
      const u = unwrap(m);
      if (u.kind === "array") return u.element;
    }
  }
  return null;
}

// --- Modules ----------------------------------------------------------------

function emptyModule(parseFailed = false): ModuleResult {
  return {
    namedValues: new Map(),
    namedTypes: new Map(),
    defaultExport: null,
    diagnostics: [],
    parseFailed,
  };
}

function gatherDiagnostics(
  moduleCache: Map<string, ModuleResult>,
  entry: string,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const seen = new Set<string>();
  // Entry first, then others in cache insertion order.
  const entryMod = moduleCache.get(entry);
  if (entryMod !== undefined) {
    for (const d of entryMod.diagnostics) {
      out.push(d);
      seen.add(diagKey(d));
    }
  }
  for (const [path, mod] of moduleCache) {
    if (path === entry) continue;
    for (const d of mod.diagnostics) {
      const k = diagKey(d);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(d);
    }
  }
  return out;
}

function diagKey(d: Diagnostic): string {
  return `${d.file ?? ""}|${d.code}|${d.message}|${d.start?.line ?? ""}|${d.start?.column ?? ""}`;
}

function checkModule(
  absolutePath: string,
  source: string,
  readFile: (absolutePath: string) => string | null,
  moduleCache: Map<string, ModuleResult>,
  checkingStack: Set<string>,
): ModuleResult {
  const cached = moduleCache.get(absolutePath);
  if (cached !== undefined) return cached;

  const { program, diagnostics: parseDiags } = parse(source, absolutePath);
  if (parseDiags.length > 0) {
    const result = emptyModule(true);
    result.diagnostics = parseDiags;
    moduleCache.set(absolutePath, result);
    return result;
  }

  checkingStack.add(absolutePath);
  const ctx: CheckerContext = {
    file: absolutePath,
    diagnostics: [],
    readFile,
    moduleCache,
    checkingStack,
    scope: {
      bindings: new Map(),
      parent: {
        bindings: new Map([
          [
            "console",
            {
              name: "console",
              kind: "value" as const,
              mutable: false,
              valueType: consoleType(),
            },
          ],
        ]),
        parent: null,
      },
    },
    narrowing: new Map(),
    returnType: null,
    thisType: null,
    inExprStmt: false,
  };

  hoistDeclarations(ctx, program);

  for (const stmt of program.body) {
    checkStatement(ctx, stmt);
  }

  const result = collectExports(ctx, program);
  result.diagnostics = ctx.diagnostics;
  checkingStack.delete(absolutePath);
  moduleCache.set(absolutePath, result);
  return result;
}

function hoistDeclarations(ctx: CheckerContext, program: Program): void {
  for (const stmt of program.body) {
    if (stmt.kind === "type_alias") hoistTypeAlias(ctx, stmt);
    else if (stmt.kind === "interface") hoistInterface(ctx, stmt);
    else if (stmt.kind === "function") hoistFunction(ctx, stmt);
    else if (stmt.kind === "class") hoistClass(ctx, stmt);
  }
  for (const stmt of program.body) {
    if (stmt.kind === "type_alias") fillTypeAlias(ctx, stmt);
    else if (stmt.kind === "interface") fillInterface(ctx, stmt);
    else if (stmt.kind === "class") fillClass(ctx, stmt);
    else if (stmt.kind === "function") fillFunctionType(ctx, stmt);
  }
  for (const stmt of program.body) {
    if (stmt.kind === "type_alias") checkAliasProductivity(ctx, stmt);
  }
}

function hoistTypeAlias(ctx: CheckerContext, stmt: TypeAlias): void {
  const typeDef: TypeDef = {
    name: stmt.name,
    typeParams: stmt.typeParams.map((t) => t.name),
    body: ERROR_TYPE,
  };
  declareInScope(
    ctx,
    {
      name: stmt.name,
      kind: "type",
      mutable: false,
      valueType: ERROR_TYPE,
      typeDef,
    },
    stmt.nameSpan,
  );
}

function fillTypeAlias(ctx: CheckerContext, stmt: TypeAlias): void {
  const binding = ctx.scope.bindings.get(stmt.name);
  if (binding?.typeDef === undefined) return;
  const tpSet = new Set(stmt.typeParams.map((t) => t.name));
  binding.typeDef.body = resolveTypeNode(ctx, stmt.type, tpSet);
}

function checkAliasProductivity(ctx: CheckerContext, stmt: TypeAlias): void {
  const binding = ctx.scope.bindings.get(stmt.name);
  if (binding?.typeDef === undefined) return;
  const def = binding.typeDef;
  if (isNonProductiveAliasBody(def.body, def)) {
    diag(
      ctx,
      "jsv.check.recursive_type",
      `Type alias '${stmt.name}' is recursively defined without an object or array.`,
      stmt.nameSpan,
    );
    def.body = ERROR_TYPE;
  }
}

function hoistInterface(ctx: CheckerContext, stmt: InterfaceDecl): void {
  const typeDef: TypeDef = {
    name: stmt.name,
    typeParams: stmt.typeParams.map((t) => t.name),
    body: ERROR_TYPE,
  };
  declareInScope(
    ctx,
    {
      name: stmt.name,
      kind: "type",
      mutable: false,
      valueType: ERROR_TYPE,
      typeDef,
    },
    stmt.nameSpan,
  );
}

function fillInterface(ctx: CheckerContext, stmt: InterfaceDecl): void {
  const binding = ctx.scope.bindings.get(stmt.name);
  if (binding?.typeDef === undefined) return;
  const tpSet = new Set(stmt.typeParams.map((t) => t.name));
  binding.typeDef.body = objectType(
    resolveTypeMembers(ctx, stmt.members, tpSet),
  );
}

function hoistFunction(ctx: CheckerContext, stmt: FunctionDecl): void {
  declareInScope(
    ctx,
    {
      name: stmt.name,
      kind: "value",
      mutable: false,
      valueType: ERROR_TYPE,
    },
    stmt.nameSpan,
  );
}

function fillFunctionType(ctx: CheckerContext, stmt: FunctionDecl): void {
  const binding = ctx.scope.bindings.get(stmt.name);
  if (binding === undefined) return;
  const tpNames = stmt.typeParams.map((t) => t.name);
  const tpSet = new Set(tpNames);
  binding.valueType = functionType(
    stmt.params.map((p) => ({
      name: p.name,
      type: resolveTypeNode(ctx, p.type, tpSet),
    })),
    resolveTypeNode(ctx, stmt.returnType, tpSet),
    tpNames,
  );
}

function hoistClass(ctx: CheckerContext, stmt: ClassDecl): void {
  const typeDef: TypeDef = {
    name: stmt.name,
    typeParams: [],
    body: ERROR_TYPE,
  };
  declareInScope(
    ctx,
    {
      name: stmt.name,
      kind: "both",
      mutable: false,
      valueType: ERROR_TYPE,
      typeDef,
    },
    stmt.nameSpan,
  );
}

function fillClass(ctx: CheckerContext, stmt: ClassDecl): void {
  const binding = ctx.scope.bindings.get(stmt.name);
  if (binding?.typeDef === undefined) return;

  const props: PropType[] = [];
  let ctorParams: FnParamType[] = [];
  let ctorCount = 0;

  for (const m of stmt.members) {
    if (m.kind === "field") {
      props.push({
        name: m.name,
        optional: false,
        type: resolveTypeNode(ctx, m.type),
      });
    } else if (m.kind === "method") {
      const tpNames = m.typeParams.map((t) => t.name);
      const tpSet = new Set(tpNames);
      props.push({
        name: m.name,
        optional: false,
        type: functionType(
          m.params.map((p) => ({
            name: p.name,
            type: resolveTypeNode(ctx, p.type, tpSet),
          })),
          resolveTypeNode(ctx, m.returnType, tpSet),
          tpNames,
        ),
      });
    } else if (m.kind === "constructor") {
      ctorCount += 1;
      if (ctorCount > 1) {
        diag(
          ctx,
          "jsv.check.duplicate_constructor",
          "Class has multiple constructors.",
          m.span,
        );
      } else {
        ctorParams = m.params.map((p) => ({
          name: p.name,
          type: resolveTypeNode(ctx, p.type),
        }));
      }
    }
  }

  binding.typeDef.body = objectType(props);
  binding.valueType = functionType(ctorParams, refType(binding.typeDef));
}

function collectExports(ctx: CheckerContext, program: Program): ModuleResult {
  const result = emptyModule();
  for (const stmt of program.body) {
    switch (stmt.kind) {
      case "var":
      case "function":
      case "class": {
        if (!stmt.exported) break;
        const b = ctx.scope.bindings.get(stmt.name);
        if (b === undefined) break;
        if (stmt.defaultExport) {
          result.defaultExport = b;
        } else {
          if (b.kind === "value" || b.kind === "both") {
            result.namedValues.set(stmt.name, b);
          }
          if (b.kind === "type" || b.kind === "both") {
            result.namedTypes.set(stmt.name, b);
          }
        }
        break;
      }
      case "type_alias":
      case "interface": {
        if (!stmt.exported) break;
        const b = ctx.scope.bindings.get(stmt.name);
        if (b === undefined) break;
        result.namedTypes.set(stmt.name, b);
        break;
      }
      default:
        break;
    }
  }
  return result;
}

function resolveAndLoadModule(
  ctx: CheckerContext,
  specifier: string,
  span: Span,
): ModuleResult | null {
  if (
    !(specifier.startsWith("./") || specifier.startsWith("../")) ||
    !specifier.endsWith(".jsv")
  ) {
    diag(
      ctx,
      "jsv.check.module_not_found",
      `Module not found: '${specifier}'.`,
      span,
    );
    return null;
  }
  const absolute = resolve(dirname(ctx.file), specifier);
  if (ctx.checkingStack.has(absolute)) {
    diag(
      ctx,
      "jsv.check.import_cycle",
      `Circular import involving '${specifier}'.`,
      span,
    );
    return null;
  }
  const cached = ctx.moduleCache.get(absolute);
  if (cached !== undefined) return cached;

  const source = ctx.readFile(absolute);
  if (source === null) {
    diag(
      ctx,
      "jsv.check.module_not_found",
      `Module not found: '${specifier}'.`,
      span,
    );
    return null;
  }
  return checkModule(
    absolute,
    source,
    ctx.readFile,
    ctx.moduleCache,
    ctx.checkingStack,
  );
}

function checkImport(
  ctx: CheckerContext,
  stmt: Statement & { kind: "import" },
): void {
  const mod = resolveAndLoadModule(ctx, stmt.moduleSpecifier, stmt.span);
  const noExports = mod === null || mod.parseFailed;

  if (stmt.defaultName !== null && stmt.defaultSpan !== null) {
    if (noExports || mod === null || mod.defaultExport === null) {
      diag(
        ctx,
        "jsv.check.missing_export",
        "Module has no default export.",
        stmt.defaultSpan,
      );
      declareInScope(
        ctx,
        {
          name: stmt.defaultName,
          kind: "value",
          mutable: false,
          valueType: ERROR_TYPE,
        },
        stmt.defaultSpan,
      );
    } else {
      const exp = mod.defaultExport;
      declareInScope(
        ctx,
        {
          name: stmt.defaultName,
          kind: exp.kind,
          mutable: false,
          valueType: exp.valueType,
          typeDef: exp.typeDef,
        },
        stmt.defaultSpan,
      );
    }
  }

  for (const name of stmt.names) {
    if (noExports || mod === null) {
      diag(
        ctx,
        "jsv.check.missing_export",
        `Module has no exported member '${name.imported}'.`,
        name.span,
      );
      declareInScope(
        ctx,
        {
          name: name.local,
          kind: "value",
          mutable: false,
          valueType: ERROR_TYPE,
        },
        name.span,
      );
      continue;
    }
    const valueExp = mod.namedValues.get(name.imported);
    const typeExp = mod.namedTypes.get(name.imported);
    if (valueExp === undefined && typeExp === undefined) {
      diag(
        ctx,
        "jsv.check.missing_export",
        `Module has no exported member '${name.imported}'.`,
        name.span,
      );
      declareInScope(
        ctx,
        {
          name: name.local,
          kind: "value",
          mutable: false,
          valueType: ERROR_TYPE,
        },
        name.span,
      );
      continue;
    }
    if (valueExp !== undefined && typeExp !== undefined) {
      declareInScope(
        ctx,
        {
          name: name.local,
          kind: "both",
          mutable: false,
          valueType: valueExp.valueType,
          typeDef: typeExp.typeDef ?? valueExp.typeDef,
        },
        name.span,
      );
    } else if (valueExp !== undefined) {
      declareInScope(
        ctx,
        {
          name: name.local,
          kind: valueExp.kind === "both" ? "both" : "value",
          mutable: false,
          valueType: valueExp.valueType,
          typeDef: valueExp.typeDef,
        },
        name.span,
      );
    } else if (typeExp !== undefined) {
      declareInScope(
        ctx,
        {
          name: name.local,
          kind: "type",
          mutable: false,
          valueType: ERROR_TYPE,
          typeDef: typeExp.typeDef,
        },
        name.span,
      );
    }
  }
}

// --- Statements -------------------------------------------------------------

function checkStatement(ctx: CheckerContext, stmt: Statement): boolean {
  switch (stmt.kind) {
    case "import":
      checkImport(ctx, stmt);
      return false;
    case "var":
      checkVar(ctx, stmt);
      return false;
    case "function":
      checkFunctionBody(ctx, stmt);
      return false;
    case "type_alias":
    case "interface":
      return false;
    case "class":
      checkClassBodies(ctx, stmt);
      return false;
    case "if":
      return checkIf(ctx, stmt);
    case "while":
      checkWhile(ctx, stmt);
      return false;
    case "for":
      checkFor(ctx, stmt);
      return false;
    case "return":
      checkReturn(ctx, stmt);
      return true;
    case "block":
      return checkBlock(ctx, stmt);
    case "empty":
      return false;
    case "expr_stmt": {
      const prev = ctx.inExprStmt;
      ctx.inExprStmt = true;
      checkExpr(ctx, stmt.expression, null);
      ctx.inExprStmt = prev;
      return false;
    }
    default: {
      const _exhaustive: never = stmt;
      return _exhaustive;
    }
  }
}

function checkBlock(ctx: CheckerContext, block: Block): boolean {
  pushScope(ctx);
  let returns = false;
  for (const s of block.body) {
    if (checkStatement(ctx, s)) returns = true;
  }
  popScope(ctx);
  return returns;
}

function checkVar(ctx: CheckerContext, stmt: VarStmt): void {
  let declaredType: Type | null = null;
  if (stmt.type !== null) {
    declaredType = resolveTypeNode(ctx, stmt.type);
  }

  if (stmt.init === null) {
    diag(
      ctx,
      "jsv.check.uninitialized",
      `'${stmt.name}' is declared but not initialized.`,
      stmt.nameSpan,
    );
    declareInScope(
      ctx,
      {
        name: stmt.name,
        kind: "value",
        mutable: stmt.declKind === "let",
        valueType: declaredType ?? ERROR_TYPE,
      },
      stmt.nameSpan,
    );
    return;
  }

  const initType = checkExpr(ctx, stmt.init, declaredType);
  rejectVoidValue(ctx, initType, stmt.init.span);
  if (declaredType !== null) {
    checkAssignability(ctx, initType, declaredType, stmt.init.span);
  }

  declareInScope(
    ctx,
    {
      name: stmt.name,
      kind: "value",
      mutable: stmt.declKind === "let",
      valueType: declaredType ?? initType,
    },
    stmt.nameSpan,
  );
}

function bindTypeParams(
  ctx: CheckerContext,
  typeParams: { name: string; span: Span }[],
): Set<string> {
  const names = new Set<string>();
  for (const tp of typeParams) {
    names.add(tp.name);
    declareInScope(
      ctx,
      {
        name: tp.name,
        kind: "type",
        mutable: false,
        valueType: ERROR_TYPE,
        typeDef: {
          name: tp.name,
          typeParams: [],
          body: { kind: "type_param", name: tp.name },
        },
      },
      tp.span,
    );
  }
  return names;
}

function checkFunctionBody(ctx: CheckerContext, stmt: FunctionDecl): void {
  pushScope(ctx);
  const tpSet = bindTypeParams(ctx, stmt.typeParams);
  for (const p of stmt.params) {
    declareInScope(
      ctx,
      {
        name: p.name,
        kind: "value",
        mutable: true,
        valueType: resolveTypeNode(ctx, p.type, tpSet),
      },
      p.nameSpan,
    );
  }
  const returnType = resolveTypeNode(ctx, stmt.returnType, tpSet);
  const prevRet = ctx.returnType;
  ctx.returnType = returnType;
  const definitelyReturns = checkBlock(ctx, stmt.body);
  ctx.returnType = prevRet;
  popScope(ctx);

  if (!isVoid(returnType) && !isNever(returnType) && !definitelyReturns) {
    diag(
      ctx,
      "jsv.check.missing_return",
      `Function '${stmt.name}' must return a value on every path.`,
      stmt.nameSpan,
    );
  }
}

function checkClassBodies(ctx: CheckerContext, stmt: ClassDecl): void {
  const binding = lookupBinding(ctx, stmt.name);
  const instance =
    binding?.typeDef !== undefined
      ? refType(binding.typeDef)
      : objectType([]);

  for (const m of stmt.members) {
    if (m.kind === "field") continue;
    if (m.kind === "constructor") {
      pushScope(ctx);
      for (const p of m.params) {
        declareInScope(
          ctx,
          {
            name: p.name,
            kind: "value",
            mutable: true,
            valueType: resolveTypeNode(ctx, p.type),
          },
          p.nameSpan,
        );
      }
      const prevThis = ctx.thisType;
      const prevRet = ctx.returnType;
      ctx.thisType = instance;
      ctx.returnType = prim("void");
      checkBlock(ctx, m.body);
      ctx.thisType = prevThis;
      ctx.returnType = prevRet;
      popScope(ctx);
    } else if (m.kind === "method") {
      pushScope(ctx);
      const tpSet = bindTypeParams(ctx, m.typeParams);
      for (const p of m.params) {
        declareInScope(
          ctx,
          {
            name: p.name,
            kind: "value",
            mutable: true,
            valueType: resolveTypeNode(ctx, p.type, tpSet),
          },
          p.nameSpan,
        );
      }
      const returnType = resolveTypeNode(ctx, m.returnType, tpSet);
      const prevThis = ctx.thisType;
      const prevRet = ctx.returnType;
      ctx.thisType = instance;
      ctx.returnType = returnType;
      const definitelyReturns = checkBlock(ctx, m.body);
      ctx.thisType = prevThis;
      ctx.returnType = prevRet;
      popScope(ctx);
      if (!isVoid(returnType) && !isNever(returnType) && !definitelyReturns) {
        diag(
          ctx,
          "jsv.check.missing_return",
          `Method '${m.name}' must return a value on every path.`,
          m.nameSpan,
        );
      }
    }
  }
}

function checkIf(
  ctx: CheckerContext,
  stmt: Statement & { kind: "if" },
): boolean {
  const trueNarrow = collectNarrowing(ctx, stmt.test, true);
  const falseNarrow = collectNarrowing(ctx, stmt.test, false);
  checkCondition(ctx, stmt.test);
  const consRet = withNarrowing(ctx, trueNarrow, () =>
    checkStatement(ctx, stmt.consequent),
  );
  let altRet = false;
  if (stmt.alternate !== null) {
    altRet = withNarrowing(ctx, falseNarrow, () =>
      checkStatement(ctx, stmt.alternate as Statement),
    );
  }
  return consRet && stmt.alternate !== null && altRet;
}

function checkWhile(
  ctx: CheckerContext,
  stmt: Statement & { kind: "while" },
): void {
  const trueNarrow = collectNarrowing(ctx, stmt.test, true);
  checkCondition(ctx, stmt.test);
  withNarrowing(ctx, trueNarrow, () => {
    checkStatement(ctx, stmt.body);
  });
}

function checkFor(
  ctx: CheckerContext,
  stmt: Statement & { kind: "for" },
): void {
  pushScope(ctx);
  if (stmt.init !== null) {
    if ("declKind" in stmt.init && stmt.init.kind === "var") {
      checkVar(ctx, stmt.init);
    } else {
      checkExpr(ctx, stmt.init as Expr, null);
    }
  }
  if (stmt.test !== null) checkCondition(ctx, stmt.test);
  if (stmt.update !== null) checkExpr(ctx, stmt.update, null);
  checkStatement(ctx, stmt.body);
  popScope(ctx);
}

function checkReturn(
  ctx: CheckerContext,
  stmt: Statement & { kind: "return" },
): void {
  if (ctx.returnType === null) {
    if (stmt.argument !== null) checkExpr(ctx, stmt.argument, null);
    return;
  }
  if (stmt.argument === null) {
    if (!isVoid(ctx.returnType)) {
      diag(
        ctx,
        "jsv.check.not_assignable",
        `Type 'void' is not assignable to type '${typeToString(ctx.returnType)}'.`,
        stmt.span,
      );
    }
    return;
  }
  const argType = checkExpr(ctx, stmt.argument, ctx.returnType);
  if (isVoid(argType) && !isVoid(ctx.returnType)) {
    diag(
      ctx,
      "jsv.check.void_value",
      "A 'void' value may only be used as an expression statement or returned from a void function.",
      stmt.argument.span,
    );
    return;
  }
  checkAssignability(ctx, argType, ctx.returnType, stmt.argument.span);
}

function checkCondition(ctx: CheckerContext, expr: Expr): void {
  const t = checkExpr(ctx, expr, prim("boolean"));
  if (t.kind === "error") return;
  if (!isAssignable(t, prim("boolean"))) {
    diag(
      ctx,
      "jsv.check.condition_not_boolean",
      `Condition must be 'boolean', but got '${typeToString(t)}'.`,
      expr.span,
    );
  }
}

function checkAssignability(
  ctx: CheckerContext,
  source: Type,
  target: Type,
  span: Span,
): void {
  if (source.kind === "error" || target.kind === "error") return;
  if (!isAssignable(source, target)) {
    diag(
      ctx,
      "jsv.check.not_assignable",
      `Type '${typeToString(source)}' is not assignable to type '${typeToString(target)}'.`,
      span,
    );
  }
}

function rejectVoidValue(ctx: CheckerContext, type: Type, span: Span): void {
  if (ctx.inExprStmt) return;
  if (isVoid(type)) {
    diag(
      ctx,
      "jsv.check.void_value",
      "A 'void' value may only be used as an expression statement or returned from a void function.",
      span,
    );
  }
}

// --- Narrowing --------------------------------------------------------------

function collectNarrowing(
  ctx: CheckerContext,
  expr: Expr,
  branch: boolean,
): NarrowMap {
  const map: NarrowMap = new Map();
  applyNarrowing(ctx, expr, branch, map);
  return map;
}

function applyNarrowing(
  ctx: CheckerContext,
  expr: Expr,
  branch: boolean,
  into: NarrowMap,
): void {
  if (expr.kind === "binary" && expr.op === "&&" && branch) {
    applyNarrowing(ctx, expr.left, true, into);
    applyNarrowing(ctx, expr.right, true, into);
    return;
  }

  if (
    expr.kind !== "binary" ||
    (expr.op !== "===" &&
      expr.op !== "!==" &&
      expr.op !== "==" &&
      expr.op !== "!=")
  ) {
    return;
  }

  const positive = expr.op === "===" || expr.op === "==";
  const effective = branch ? positive : !positive;

  // typeof x === "string"
  const typeofNarrow = tryTypeofNarrow(ctx, expr.left, expr.right, effective);
  if (typeofNarrow !== null) {
    into.set(typeofNarrow.name, typeofNarrow.type);
    return;
  }
  const typeofNarrowR = tryTypeofNarrow(ctx, expr.right, expr.left, effective);
  if (typeofNarrowR !== null) {
    into.set(typeofNarrowR.name, typeofNarrowR.type);
    return;
  }

  const applyLit = (idName: string, lit: Expr): void => {
    const cur =
      into.get(idName) ?? lookupValueType(ctx, idName) ?? ERROR_TYPE;
    if (cur.kind === "error") return;
    if (lit.kind === "null") {
      into.set(
        idName,
        effective ? prim("null") : excludeType(cur, prim("null")),
      );
    } else if (lit.kind === "undefined") {
      into.set(
        idName,
        effective
          ? prim("undefined")
          : excludeType(cur, prim("undefined")),
      );
    } else if (lit.kind === "boolean") {
      into.set(
        idName,
        effective ? intersectNarrow(cur, prim("boolean")) : cur,
      );
    }
  };

  if (expr.left.kind === "ident") applyLit(expr.left.name, expr.right);
  if (expr.right.kind === "ident") applyLit(expr.right.name, expr.left);
}

function tryTypeofNarrow(
  ctx: CheckerContext,
  typeofSide: Expr,
  litSide: Expr,
  effective: boolean,
): { name: string; type: Type } | null {
  if (
    typeofSide.kind !== "unary" ||
    typeofSide.op !== "typeof" ||
    typeofSide.argument.kind !== "ident" ||
    litSide.kind !== "string"
  ) {
    return null;
  }
  const name = typeofSide.argument.name;
  const cur = lookupValueType(ctx, name) ?? ERROR_TYPE;
  if (cur.kind === "error") return null;

  const tag = litSide.value;
  let asType: Type | null = null;
  if (tag === "string") asType = prim("string");
  else if (tag === "number") asType = prim("number");
  else if (tag === "boolean") asType = prim("boolean");
  else if (tag === "undefined") asType = prim("undefined");
  else return null;

  if (effective) {
    return { name, type: intersectNarrow(cur, asType) };
  }
  return { name, type: excludeType(cur, asType) };
}

// --- Expressions ------------------------------------------------------------

function checkExpr(
  ctx: CheckerContext,
  expr: Expr,
  expected: Type | null,
): Type {
  switch (expr.kind) {
    case "number":
      return prim("number");
    case "string":
      return prim("string");
    case "boolean":
      return prim("boolean");
    case "null":
      return prim("null");
    case "undefined":
      return prim("undefined");
    case "ident":
      return checkIdent(ctx, expr);
    case "template":
      return checkTemplate(ctx, expr);
    case "array":
      return checkArray(ctx, expr, expected);
    case "object":
      return checkObject(ctx, expr, expected);
    case "unary":
      return checkUnary(ctx, expr);
    case "binary":
      return checkBinary(ctx, expr);
    case "assign":
      return checkAssign(ctx, expr);
    case "ternary":
      return checkTernary(ctx, expr, expected);
    case "call":
      return checkCall(ctx, expr);
    case "member":
      return checkMember(ctx, expr);
    case "index":
      return checkIndex(ctx, expr);
    case "new":
      return checkNew(ctx, expr);
    case "arrow":
      return checkArrow(ctx, expr, expected);
    case "assert":
      return checkAssert(ctx, expr);
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}

function checkIdent(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "ident" }>,
): Type {
  if (expr.name === "this") {
    if (ctx.thisType === null) {
      diag(
        ctx,
        "jsv.check.unresolved_name",
        "Unresolved name 'this'.",
        expr.span,
      );
      return ERROR_TYPE;
    }
    return ctx.thisType;
  }
  const narrowed = ctx.narrowing.get(expr.name);
  if (narrowed !== undefined) return narrowed;

  const b = lookupBinding(ctx, expr.name);
  if (b === null) {
    diag(
      ctx,
      "jsv.check.unresolved_name",
      `Unresolved name '${expr.name}'.`,
      expr.span,
    );
    return ERROR_TYPE;
  }
  if (b.kind === "type") {
    diag(
      ctx,
      "jsv.check.type_as_value",
      `'${expr.name}' refers to a type, but is used as a value.`,
      expr.span,
    );
    return ERROR_TYPE;
  }
  return b.valueType;
}

function checkTemplate(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "template" }>,
): Type {
  for (const part of expr.parts) {
    if (part.kind !== "expr") continue;
    const t = checkExpr(ctx, part.expr, null);
    rejectVoidValue(ctx, t, part.expr.span);
    if (t.kind !== "error" && !isInterpolatable(t)) {
      diag(
        ctx,
        "jsv.check.bad_interpolation",
        `Template interpolation type '${typeToString(t)}' must be string, number, or boolean.`,
        part.expr.span,
      );
    }
  }
  return prim("string");
}

function isInterpolatable(type: Type): boolean {
  const t = unwrap(type);
  if (t.kind === "prim") {
    return (
      t.name === "string" || t.name === "number" || t.name === "boolean"
    );
  }
  if (t.kind === "union") return t.members.every(isInterpolatable);
  return false;
}

function checkArray(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "array" }>,
  expected: Type | null,
): Type {
  const expectedElement = expectedArrayElement(expected);

  if (expr.elements.length === 0) {
    if (expectedElement !== null) return arrayType(expectedElement);
    diag(
      ctx,
      "jsv.check.empty_array",
      "Empty array literal requires a type annotation.",
      expr.span,
    );
    return ERROR_TYPE;
  }

  const elemTypes: Type[] = [];
  for (const el of expr.elements) {
    const t = checkExpr(ctx, el, expectedElement);
    rejectVoidValue(ctx, t, el.span);
    if (expectedElement !== null) {
      checkAssignability(ctx, t, expectedElement, el.span);
    }
    elemTypes.push(t);
  }
  if (expectedElement !== null) return arrayType(expectedElement);
  return arrayType(unionType(elemTypes));
}

function checkObject(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "object" }>,
  expected: Type | null,
): Type {
  const expectedObj = expectedObjectType(expected);
  const props: PropType[] = [];
  const seen = new Set<string>();

  for (const p of expr.properties) {
    seen.add(p.name);
    const expectedProp = expectedObj?.props.find((x) => x.name === p.name);
    const expectedPropType = expectedProp?.type ?? null;

    let valueType: Type;
    if (p.shorthand) {
      valueType = checkIdent(ctx, {
        kind: "ident",
        name: p.name,
        span: p.nameSpan,
      });
    } else {
      valueType = checkExpr(ctx, p.value, expectedPropType);
    }
    rejectVoidValue(ctx, valueType, p.value.span);

    if (expectedPropType !== null) {
      checkAssignability(ctx, valueType, expectedPropType, p.value.span);
    } else if (expectedObj !== null && expected !== null) {
      diag(
        ctx,
        "jsv.check.not_assignable",
        `Type '{ ${p.name}: ${typeToString(valueType)} }' is not assignable to type '${typeToString(expected)}': unknown property '${p.name}'.`,
        p.nameSpan,
      );
    }

    props.push({
      name: p.name,
      optional: false,
      type: expectedPropType ?? valueType,
    });
  }

  if (expectedObj !== null && expected !== null) {
    for (const req of expectedObj.props) {
      if (req.optional) continue;
      if (!seen.has(req.name)) {
        diag(
          ctx,
          "jsv.check.not_assignable",
          `Type '${typeToString(objectType(props))}' is not assignable to type '${typeToString(expected)}'.`,
          expr.span,
        );
        break;
      }
    }
    return expected;
  }

  return objectType(props);
}

function checkUnary(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "unary" }>,
): Type {
  if (expr.op === "typeof") {
    checkExpr(ctx, expr.argument, null);
    return prim("string");
  }
  if (expr.op === "!") {
    const t = checkExpr(ctx, expr.argument, prim("boolean"));
    if (t.kind !== "error" && !isAssignable(t, prim("boolean"))) {
      diag(
        ctx,
        "jsv.check.condition_not_boolean",
        `Operand of '!' must be 'boolean', but got '${typeToString(t)}'.`,
        expr.argument.span,
      );
    }
    return prim("boolean");
  }
  const t = checkExpr(ctx, expr.argument, prim("number"));
  rejectVoidValue(ctx, t, expr.argument.span);
  if (t.kind !== "error" && !isAssignable(t, prim("number"))) {
    diag(
      ctx,
      "jsv.check.bad_operator",
      `Operator '-' cannot be applied to type '${typeToString(t)}'.`,
      expr.span,
    );
    return ERROR_TYPE;
  }
  return prim("number");
}

function checkBinary(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "binary" }>,
): Type {
  const op = expr.op;

  if (op === "&&" || op === "||") {
    checkCondition(ctx, expr.left);
    checkCondition(ctx, expr.right);
    return prim("boolean");
  }

  if (op === "==" || op === "!=" || op === "===" || op === "!==") {
    const lt = checkExpr(ctx, expr.left, null);
    const rt = checkExpr(ctx, expr.right, null);
    if (lt.kind !== "error" && rt.kind !== "error" && !typesOverlap(lt, rt)) {
      diag(
        ctx,
        "jsv.check.unrelated_comparison",
        `This comparison appears unintentional because the types '${typeToString(lt)}' and '${typeToString(rt)}' have no overlap.`,
        expr.span,
      );
    }
    return prim("boolean");
  }

  if (op === "<" || op === ">" || op === "<=" || op === ">=") {
    const lt = checkExpr(ctx, expr.left, prim("number"));
    const rt = checkExpr(ctx, expr.right, prim("number"));
    rejectVoidValue(ctx, lt, expr.left.span);
    rejectVoidValue(ctx, rt, expr.right.span);
    if (
      (lt.kind !== "error" && !isAssignable(lt, prim("number"))) ||
      (rt.kind !== "error" && !isAssignable(rt, prim("number")))
    ) {
      diag(
        ctx,
        "jsv.check.bad_operator",
        `Operator '${op}' cannot be applied to types '${typeToString(lt)}' and '${typeToString(rt)}'.`,
        expr.span,
      );
    }
    return prim("boolean");
  }

  if (op === "+") {
    const lt = checkExpr(ctx, expr.left, null);
    const rt = checkExpr(ctx, expr.right, null);
    rejectVoidValue(ctx, lt, expr.left.span);
    rejectVoidValue(ctx, rt, expr.right.span);
    if (lt.kind === "error" || rt.kind === "error") return ERROR_TYPE;
    if (isAssignable(lt, prim("number")) && isAssignable(rt, prim("number"))) {
      return prim("number");
    }
    const leftStr = isAssignable(lt, prim("string"));
    const rightStr = isAssignable(rt, prim("string"));
    const leftNum = isAssignable(lt, prim("number"));
    const rightNum = isAssignable(rt, prim("number"));
    if (
      (leftStr || leftNum) &&
      (rightStr || rightNum) &&
      (leftStr || rightStr)
    ) {
      return prim("string");
    }
    diag(
      ctx,
      "jsv.check.bad_operator",
      `Operator '+' cannot be applied to types '${typeToString(lt)}' and '${typeToString(rt)}'.`,
      expr.span,
    );
    return ERROR_TYPE;
  }

  const lt = checkExpr(ctx, expr.left, prim("number"));
  const rt = checkExpr(ctx, expr.right, prim("number"));
  rejectVoidValue(ctx, lt, expr.left.span);
  rejectVoidValue(ctx, rt, expr.right.span);
  if (
    (lt.kind !== "error" && !isAssignable(lt, prim("number"))) ||
    (rt.kind !== "error" && !isAssignable(rt, prim("number")))
  ) {
    diag(
      ctx,
      "jsv.check.bad_operator",
      `Operator '${op}' cannot be applied to types '${typeToString(lt)}' and '${typeToString(rt)}'.`,
      expr.span,
    );
    return ERROR_TYPE;
  }
  return prim("number");
}

function checkAssign(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "assign" }>,
): Type {
  const target = expr.target;

  if (target.kind === "ident" && target.name === "this") {
    diag(ctx, "jsv.check.assign_const", "Cannot assign to 'this'.", target.span);
    checkExpr(ctx, expr.value, null);
    return ERROR_TYPE;
  }

  if (target.kind === "ident") {
    const b = lookupBinding(ctx, target.name);
    if (b === null) {
      diag(
        ctx,
        "jsv.check.unresolved_name",
        `Unresolved name '${target.name}'.`,
        target.span,
      );
      checkExpr(ctx, expr.value, null);
      return ERROR_TYPE;
    }
    if (b.kind === "type") {
      diag(
        ctx,
        "jsv.check.type_as_value",
        `'${target.name}' refers to a type, but is used as a value.`,
        target.span,
      );
      checkExpr(ctx, expr.value, null);
      return ERROR_TYPE;
    }
    if (!b.mutable) {
      diag(
        ctx,
        "jsv.check.assign_const",
        `Cannot assign to '${target.name}' because it is a constant.`,
        target.span,
      );
    }
    const valueType = checkExpr(ctx, expr.value, b.valueType);
    rejectVoidValue(ctx, valueType, expr.value.span);
    checkAssignability(ctx, valueType, b.valueType, expr.value.span);
    return b.valueType;
  }

  if (target.kind === "member") {
    const objType = checkExpr(ctx, target.object, null);
    const prop = getProperty(objType, target.property);
    if (prop === null) {
      const known = propertyNames(objType);
      diag(
        ctx,
        "jsv.check.missing_property",
        `Property '${target.property}' does not exist.`,
        target.propertySpan,
        known.length > 0
          ? `Known properties: ${known.join(", ")}`
          : undefined,
      );
      checkExpr(ctx, expr.value, null);
      return ERROR_TYPE;
    }
    const writeType = prop.optional
      ? optionalReadType(prop.type)
      : prop.type;
    const valueType = checkExpr(ctx, expr.value, writeType);
    rejectVoidValue(ctx, valueType, expr.value.span);
    checkAssignability(ctx, valueType, writeType, expr.value.span);
    return writeType;
  }

  if (target.kind === "index") {
    const objType = checkExpr(ctx, target.object, null);
    const indexType = checkExpr(ctx, target.index, prim("number"));
    const expanded = unwrap(objType);
    if (expanded.kind !== "array") {
      diag(
        ctx,
        "jsv.check.not_indexable",
        `Type '${typeToString(objType)}' is not indexable.`,
        target.object.span,
      );
      checkExpr(ctx, expr.value, null);
      return ERROR_TYPE;
    }
    if (
      indexType.kind !== "error" &&
      !isAssignable(indexType, prim("number"))
    ) {
      diag(
        ctx,
        "jsv.check.not_assignable",
        `Type '${typeToString(indexType)}' is not assignable to type 'number'.`,
        target.index.span,
      );
    }
    const valueType = checkExpr(ctx, expr.value, expanded.element);
    rejectVoidValue(ctx, valueType, expr.value.span);
    checkAssignability(ctx, valueType, expanded.element, expr.value.span);
    return expanded.element;
  }

  diag(
    ctx,
    "jsv.check.unresolved_name",
    "Invalid assignment target.",
    target.span,
  );
  checkExpr(ctx, expr.value, null);
  return ERROR_TYPE;
}

function checkTernary(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "ternary" }>,
  expected: Type | null,
): Type {
  const trueNarrow = collectNarrowing(ctx, expr.test, true);
  const falseNarrow = collectNarrowing(ctx, expr.test, false);
  checkCondition(ctx, expr.test);
  const ct = withNarrowing(ctx, trueNarrow, () =>
    checkExpr(ctx, expr.consequent, expected),
  );
  const at = withNarrowing(ctx, falseNarrow, () =>
    checkExpr(ctx, expr.alternate, expected),
  );
  rejectVoidValue(ctx, ct, expr.consequent.span);
  rejectVoidValue(ctx, at, expr.alternate.span);
  if (expected !== null) return expected;
  return unionType([ct, at]);
}

function checkCall(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "call" }>,
): Type {
  const calleeType = checkExpr(ctx, expr.callee, null);
  const fn = unwrap(calleeType);

  if (fn.kind !== "function") {
    if (calleeType.kind !== "error") {
      diag(
        ctx,
        "jsv.check.not_callable",
        `Type '${typeToString(calleeType)}' is not callable.`,
        expr.callee.span,
      );
    }
    for (const a of expr.args) checkExpr(ctx, a, null);
    return ERROR_TYPE;
  }

  const subst = new Map<string, Type>();
  if (fn.typeParams.length > 0) {
    if (expr.typeArgs.length === 0) {
      diag(
        ctx,
        "jsv.check.missing_type_arguments",
        "Generic function requires type arguments.",
        expr.callee.span,
      );
      for (const a of expr.args) checkExpr(ctx, a, null);
      return ERROR_TYPE;
    }
    if (expr.typeArgs.length !== fn.typeParams.length) {
      diag(
        ctx,
        "jsv.check.type_argument_count",
        `Expected ${fn.typeParams.length} type argument(s), got ${expr.typeArgs.length}.`,
        expr.span,
      );
      for (const a of expr.args) checkExpr(ctx, a, null);
      return ERROR_TYPE;
    }
    const args = expr.typeArgs.map((t) => resolveTypeNode(ctx, t));
    for (let i = 0; i < fn.typeParams.length; i++) {
      const tp = fn.typeParams[i];
      const arg = args[i];
      if (tp !== undefined && arg !== undefined) subst.set(tp, arg);
    }
  } else if (expr.typeArgs.length > 0) {
    diag(
      ctx,
      "jsv.check.unexpected_type_arguments",
      "Type arguments are not expected here.",
      expr.span,
    );
  }

  const params = fn.params.map((p) => ({
    name: p.name,
    type: substitute(p.type, subst),
  }));
  const returnType = substitute(fn.returnType, subst);

  if (fn.anyArity === true) {
    for (const a of expr.args) {
      const t = checkExpr(ctx, a, prim("unknown"));
      rejectVoidValue(ctx, t, a.span);
    }
    return returnType;
  }

  if (expr.args.length !== params.length) {
    diag(
      ctx,
      "jsv.check.argument_count",
      `Expected ${params.length} argument(s), got ${expr.args.length}.`,
      expr.span,
    );
  }
  const n = Math.min(expr.args.length, params.length);
  for (let i = 0; i < n; i++) {
    const arg = expr.args[i];
    const param = params[i];
    if (arg === undefined || param === undefined) continue;
    const t = checkExpr(ctx, arg, param.type);
    rejectVoidValue(ctx, t, arg.span);
    checkAssignability(ctx, t, param.type, arg.span);
  }
  for (let i = n; i < expr.args.length; i++) {
    const arg = expr.args[i];
    if (arg !== undefined) checkExpr(ctx, arg, null);
  }
  return returnType;
}

function checkMember(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "member" }>,
): Type {
  const objType = checkExpr(ctx, expr.object, null);
  const prop = getProperty(objType, expr.property);
  if (prop === null) {
    if (objType.kind === "error") return ERROR_TYPE;
    const known = propertyNames(objType);
    diag(
      ctx,
      "jsv.check.missing_property",
      `Property '${expr.property}' does not exist on type '${typeToString(objType)}'.`,
      expr.propertySpan,
      known.length > 0 ? `Known properties: ${known.join(", ")}` : undefined,
    );
    return ERROR_TYPE;
  }
  return prop.optional ? optionalReadType(prop.type) : prop.type;
}

function checkIndex(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "index" }>,
): Type {
  const objType = checkExpr(ctx, expr.object, null);
  const indexType = checkExpr(ctx, expr.index, prim("number"));
  rejectVoidValue(ctx, indexType, expr.index.span);
  const expanded = unwrap(objType);
  if (expanded.kind !== "array") {
    if (objType.kind !== "error") {
      diag(
        ctx,
        "jsv.check.not_indexable",
        `Type '${typeToString(objType)}' is not indexable.`,
        expr.object.span,
      );
    }
    return ERROR_TYPE;
  }
  if (
    indexType.kind !== "error" &&
    !isAssignable(indexType, prim("number"))
  ) {
    diag(
      ctx,
      "jsv.check.not_assignable",
      `Type '${typeToString(indexType)}' is not assignable to type 'number'.`,
      expr.index.span,
    );
  }
  return expanded.element;
}

function checkNew(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "new" }>,
): Type {
  if (expr.typeArgs.length > 0) {
    diag(
      ctx,
      "jsv.check.unexpected_type_arguments",
      "Classes are not generic; type arguments are not allowed on 'new'.",
      expr.span,
    );
  }

  if (expr.callee.kind === "ident") {
    const b = lookupBinding(ctx, expr.callee.name);
    if (b === null) {
      diag(
        ctx,
        "jsv.check.unresolved_name",
        `Unresolved name '${expr.callee.name}'.`,
        expr.callee.span,
      );
      for (const a of expr.args) checkExpr(ctx, a, null);
      return ERROR_TYPE;
    }
    if (b.kind === "type") {
      diag(
        ctx,
        "jsv.check.type_as_value",
        `'${expr.callee.name}' refers to a type, but is used as a value.`,
        expr.callee.span,
      );
      for (const a of expr.args) checkExpr(ctx, a, null);
      return ERROR_TYPE;
    }
    if (b.kind !== "both" || b.typeDef === undefined) {
      diag(
        ctx,
        "jsv.check.not_constructable",
        `Type '${typeToString(b.valueType)}' is not constructable.`,
        expr.callee.span,
      );
      for (const a of expr.args) checkExpr(ctx, a, null);
      return ERROR_TYPE;
    }
    const ctor = b.valueType;
    const instance = refType(b.typeDef);
    if (ctor.kind === "function") {
      if (expr.args.length !== ctor.params.length) {
        diag(
          ctx,
          "jsv.check.argument_count",
          `Expected ${ctor.params.length} argument(s), got ${expr.args.length}.`,
          expr.span,
        );
      }
      const n = Math.min(expr.args.length, ctor.params.length);
      for (let i = 0; i < n; i++) {
        const arg = expr.args[i];
        const param = ctor.params[i];
        if (arg === undefined || param === undefined) continue;
        const t = checkExpr(ctx, arg, param.type);
        rejectVoidValue(ctx, t, arg.span);
        checkAssignability(ctx, t, param.type, arg.span);
      }
      for (let i = n; i < expr.args.length; i++) {
        const arg = expr.args[i];
        if (arg !== undefined) checkExpr(ctx, arg, null);
      }
    }
    return instance;
  }

  const calleeType = checkExpr(ctx, expr.callee, null);
  diag(
    ctx,
    "jsv.check.not_constructable",
    `Type '${typeToString(calleeType)}' is not constructable.`,
    expr.callee.span,
  );
  for (const a of expr.args) checkExpr(ctx, a, null);
  return ERROR_TYPE;
}

function checkArrow(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "arrow" }>,
  expected: Type | null,
): Type {
  const exp = expected !== null ? unwrap(expected) : null;
  const expectedFn = exp !== null && exp.kind === "function" ? exp : null;

  pushScope(ctx);
  const prevThis = ctx.thisType;
  ctx.thisType = null;

  const params: FnParamType[] = [];
  for (const p of expr.params) {
    const pType = resolveTypeNode(ctx, p.type);
    declareInScope(
      ctx,
      {
        name: p.name,
        kind: "value",
        mutable: true,
        valueType: pType,
      },
      p.nameSpan,
    );
    params.push({ name: p.name, type: pType });
  }

  let returnType: Type;
  if (expr.body.kind === "block") {
    const declaredRet = expectedFn?.returnType ?? prim("void");
    const prevRet = ctx.returnType;
    ctx.returnType = declaredRet;
    const definitelyReturns = checkBlock(ctx, expr.body);
    ctx.returnType = prevRet;
    returnType = expectedFn !== null ? declaredRet : prim("void");
    if (
      expectedFn !== null &&
      !isVoid(declaredRet) &&
      !isNever(declaredRet) &&
      !definitelyReturns
    ) {
      diag(
        ctx,
        "jsv.check.missing_return",
        "Function must return a value on every path.",
        expr.span,
      );
    }
  } else {
    const expectedRet = expectedFn?.returnType ?? null;
    returnType = checkExpr(ctx, expr.body, expectedRet);
    rejectVoidValue(ctx, returnType, expr.body.span);
    if (expectedRet !== null) {
      checkAssignability(ctx, returnType, expectedRet, expr.body.span);
      returnType = expectedRet;
    }
  }

  ctx.thisType = prevThis;
  popScope(ctx);
  return functionType(params, returnType);
}

function checkAssert(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "assert" }>,
): Type {
  const source = checkExpr(ctx, expr.expression, null);
  const target = resolveTypeNode(ctx, expr.type);
  if (
    source.kind !== "error" &&
    target.kind !== "error" &&
    !typesOverlap(source, target) &&
    !isUnknown(source) &&
    !isUnknown(target)
  ) {
    diag(
      ctx,
      "jsv.check.impossible_assertion",
      `Type '${typeToString(source)}' cannot be asserted as '${typeToString(target)}' because the types do not overlap.`,
      expr.span,
    );
  }
  return target;
}

// --- Public API -------------------------------------------------------------

export function checkSource(
  source: string,
  file: string,
  options?: CheckOptions,
): { diagnostics: Diagnostic[] } {
  const readFile = options?.readFile ?? defaultReadFile;
  const absolute = resolve(file);
  const moduleCache = new Map<string, ModuleResult>();
  const checkingStack = new Set<string>();
  checkModule(absolute, source, readFile, moduleCache, checkingStack);
  return { diagnostics: gatherDiagnostics(moduleCache, absolute) };
}

export function checkFile(
  file: string,
  options?: CheckOptions,
): { diagnostics: Diagnostic[] } {
  const readFile = options?.readFile ?? defaultReadFile;
  const absolute = resolve(file);
  const source = readFile(absolute);
  if (source === null) {
    return {
      diagnostics: [
        {
          code: "jsv.check.module_not_found",
          severity: "error",
          message: `Module not found: '${file}'.`,
          file: absolute,
        },
      ],
    };
  }
  return checkSource(source, absolute, { readFile });
}
