import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Diagnostic, SourcePosition } from "../diagnostics.ts";
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
import { createDomLibModule } from "./dom-lib.ts";
import {
  ERROR_TYPE,
  PROMISE_DEF,
  arrayType,
  awaitType,
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
  promiseInner,
  promiseType,
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
import {
  resolveExistingModule,
  unresolvedModuleMessage,
} from "./resolve-module.ts";

export type TypeArgHint = {
  /** Diagnostic start (1-based). */
  line: number;
  column: number;
  /** Inferred type-argument strings, in parameter order. */
  args: string[];
};

export type BindingOrigin =
  | "local"
  | "param"
  | "import"
  | "declaration"
  | "ambient";

export type CapturedBinding = {
  name: string;
  kind: "value" | "type" | "both";
  origin: BindingOrigin;
  type: string;
};

export type CompletionCapture = {
  line: number;
  column: number;
  source: string;
  scopeBest: { extent: number; bindings: CapturedBinding[] } | null;
  memberBest: {
    extent: number;
    objectType: Type;
    propertySpan: Span;
  } | null;
};

export type CheckOptions = {
  readFile?: (absolutePath: string) => string | null;
  /** When set, typecheck even if the parse produced diagnostics. */
  typecheckPartial?: boolean;
  /** Filled with unambiguous call/annotation type-argument inferences. */
  typeArgHints?: TypeArgHint[];
  /** Filled with the scope (and member receiver) at line/column. */
  completion?: CompletionCapture;
  typeQuery?: {
    line: number;
    column: number;
    hits: { span: Span; type: Type }[];
  };
};

type BindingKind = "value" | "type" | "both";

type Binding = {
  name: string;
  kind: BindingKind;
  origin: BindingOrigin;
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
  /** When true, `return expr` may be `T` or `Promise<T>` and `returnType` is `T`. */
  asyncFn: boolean;
  /** When true, `await` is allowed in this function. */
  inAsync: boolean;
  thisType: Type | null;
  inExprStmt: boolean;
  typeArgHints?: TypeArgHint[];
  completion?: CompletionCapture;
  typeQuery?: {
    line: number;
    column: number;
    hits: { span: Span; type: Type }[];
  };
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

function originForScope(ctx: CheckerContext): BindingOrigin {
  if (ctx.scope.parent === null) return "ambient";
  if (ctx.scope.parent.parent === null) return "declaration";
  return "local";
}

function declareInScope(
  ctx: CheckerContext,
  binding: Omit<Binding, "origin"> & { origin?: BindingOrigin },
  span: Span,
): void {
  const full: Binding = {
    ...binding,
    origin: binding.origin ?? originForScope(ctx),
  };
  if (ctx.scope.bindings.has(full.name)) {
    diag(
      ctx,
      "jsv.check.duplicate_declaration",
      `Duplicate declaration of '${full.name}'.`,
      span,
    );
    return;
  }
  ctx.scope.bindings.set(full.name, full);
}

function typeBindingLabel(binding: Binding): string {
  const def = binding.typeDef;
  if (def === undefined) return binding.name;
  if (def.typeParams.length === 0) return def.name;
  return `${def.name}<${def.typeParams.join(", ")}>`;
}

function snapshotBindings(ctx: CheckerContext): CapturedBinding[] {
  const out: CapturedBinding[] = [];
  const seen = new Set<string>();
  let scope: Scope | null = ctx.scope;
  while (scope !== null) {
    for (const binding of scope.bindings.values()) {
      if (seen.has(binding.name)) continue;
      seen.add(binding.name);
      const narrowed = ctx.narrowing.get(binding.name);
      out.push({
        name: binding.name,
        kind: binding.kind,
        origin: binding.origin,
        type:
          binding.kind === "type"
            ? typeBindingLabel(binding)
            : typeToString(narrowed ?? binding.valueType),
      });
    }
    scope = scope.parent;
  }
  return out;
}

function captureScope(ctx: CheckerContext, span: Span): void {
  const cap = ctx.completion;
  if (cap === undefined) return;
  if (!containsPosition(span, cap.line, cap.column)) return;
  const extent = spanExtent(cap.source, span);
  const bindings = snapshotBindings(ctx);
  if (cap.scopeBest === null || extent <= cap.scopeBest.extent) {
    cap.scopeBest = { extent, bindings };
  }
}

function endsBeforeCursor(ctx: CheckerContext, span: Span): boolean {
  const cap = ctx.completion;
  if (cap === undefined) return false;
  return (
    span.end.line < cap.line ||
    (span.end.line === cap.line && span.end.column < cap.column)
  );
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

function fnParamsFrom(
  ctx: CheckerContext,
  params: { name: string; optional: boolean; type: TypeNode }[],
  typeParamNames: Set<string>,
): FnParamType[] {
  return params.map((p) => {
    const out: FnParamType = {
      name: p.name,
      type: resolveTypeNode(ctx, p.type, typeParamNames),
    };
    if (p.optional) out.optional = true;
    return out;
  });
}

function paramExpected(p: FnParamType): Type {
  return p.optional === true ? optionalReadType(p.type) : p.type;
}

function minArity(params: readonly FnParamType[]): number {
  let i = params.length;
  while (i > 0 && params[i - 1]?.optional === true) i -= 1;
  return i;
}

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
        optional: m.optional,
        type: functionType(
          fnParamsFrom(ctx, m.params, inner),
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
  const type = resolveTypeNodeBody(ctx, node, typeParamNames);
  if (ctx.typeQuery !== undefined) {
    ctx.typeQuery.hits.push({ span: node.span, type });
  }
  return type;
}

function resolveTypeNodeBody(
  ctx: CheckerContext,
  node: TypeNode,
  typeParamNames: Set<string>,
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
        fnParamsFrom(ctx, node.params, typeParamNames),
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
  typeQuery?: CheckOptions["typeQuery"],
  extras?: {
    typecheckPartial?: boolean;
    typeArgHints?: TypeArgHint[];
    completion?: CompletionCapture;
  },
): ModuleResult {
  const cached = moduleCache.get(absolutePath);
  if (cached !== undefined) return cached;

  const { program, diagnostics: parseDiags } = parse(source, absolutePath);
  const partial = extras?.typecheckPartial === true;
  if (parseDiags.length > 0 && !partial) {
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
    typeArgHints: extras?.typeArgHints,
    completion: extras?.completion,
    scope: {
      bindings: new Map(),
      parent: {
        bindings: new Map([
          [
            "console",
            {
              name: "console",
              kind: "value" as const,
              origin: "ambient",
              mutable: false,
              valueType: consoleType(),
            },
          ],
          [
            "Promise",
            {
              name: "Promise",
              kind: "type" as const,
              origin: "ambient",
              mutable: false,
              valueType: ERROR_TYPE,
              typeDef: PROMISE_DEF,
            },
          ],
        ]),
        parent: null,
      },
    },
    narrowing: new Map(),
    returnType: null,
    asyncFn: false,
    inAsync: false,
    thisType: null,
    inExprStmt: false,
    typeQuery,
  };

  // Imports first so imported types are in scope for hoisted signatures.
  for (const stmt of program.body) {
    if (stmt.kind === "import") checkImport(ctx, stmt);
  }

  hoistDeclarations(ctx, program);

  captureScope(ctx, program.span);
  for (const stmt of program.body) {
    if (stmt.kind === "import") continue;
    checkStatement(ctx, stmt);
    if (endsBeforeCursor(ctx, stmt.span)) captureScope(ctx, program.span);
  }

  const result = collectExports(ctx, program);
  result.diagnostics =
    parseDiags.length > 0
      ? [...parseDiags, ...ctx.diagnostics]
      : ctx.diagnostics;
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
    fnParamsFrom(ctx, stmt.params, tpSet),
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
        optional: m.optional,
        type: resolveTypeNode(ctx, m.type),
      });
    } else if (m.kind === "method") {
      const tpNames = m.typeParams.map((t) => t.name);
      const tpSet = new Set(tpNames);
      props.push({
        name: m.name,
        optional: false,
        type: functionType(
          fnParamsFrom(ctx, m.params, tpSet),
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
        ctorParams = fnParamsFrom(ctx, m.params, new Set());
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
  if (specifier === "jsv/dom") {
    const cached = ctx.moduleCache.get("jsv/dom");
    if (cached !== undefined) return cached;
    const mod = createDomLibModule() as ModuleResult;
    ctx.moduleCache.set("jsv/dom", mod);
    return mod;
  }
  const resolved = resolveExistingModule(ctx.file, specifier, (absolute) => {
    if (ctx.checkingStack.has(absolute) || ctx.moduleCache.has(absolute)) {
      return true;
    }
    return ctx.readFile(absolute) !== null;
  });
  if (resolved === null) {
    const missing = unresolvedModuleMessage(specifier);
    diag(ctx, "jsv.check.module_not_found", missing.message, span, missing.hint);
    return null;
  }
  const absolute = resolved.absolute;
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
    const missing = unresolvedModuleMessage(specifier);
    diag(ctx, "jsv.check.module_not_found", missing.message, span, missing.hint);
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
          origin: "import",
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
          origin: "import",
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
          origin: "import",
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
          origin: "import",
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
          origin: "import",
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
          origin: "import",
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
          origin: "import",
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
  captureScope(ctx, stmt.span);
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
  captureScope(ctx, block.span);
  let returns = false;
  for (const s of block.body) {
    if (checkStatement(ctx, s)) returns = true;
    if (endsBeforeCursor(ctx, s.span)) captureScope(ctx, block.span);
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
  if (
    stmt.type !== null &&
    stmt.type.kind === "named" &&
    stmt.type.args.length === 0
  ) {
    const named = lookupBinding(ctx, stmt.type.name);
    if (named?.typeDef !== undefined) {
      recordTypeArgHint(
        ctx,
        stmt.type.span.start.line,
        stmt.type.span.start.column,
        inferTypeArgsFromValue(named.typeDef, initType),
      );
    }
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
        origin: "param",
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

function bindValueParams(
  ctx: CheckerContext,
  params: { name: string; nameSpan: Span; optional: boolean; type: TypeNode }[],
  typeParamNames: Set<string>,
): void {
  for (const p of params) {
    const declared = resolveTypeNode(ctx, p.type, typeParamNames);
    declareInScope(
      ctx,
      {
        name: p.name,
        kind: "value",
        origin: "param",
        mutable: true,
        valueType: p.optional ? optionalReadType(declared) : declared,
      },
      p.nameSpan,
    );
  }
}

function asyncReturnInner(
  ctx: CheckerContext,
  annotated: Type,
  span: Span,
): Type {
  const inner = promiseInner(annotated);
  if (inner !== null) return inner;
  diag(
    ctx,
    "jsv.check.async_return",
    `The return type of an async function must be 'Promise<T>', but got '${typeToString(annotated)}'.`,
    span,
    "Annotate the return type as Promise<T>. The body may return T or Promise<T>.",
  );
  return ERROR_TYPE;
}

function checkFunctionBody(ctx: CheckerContext, stmt: FunctionDecl): void {
  pushScope(ctx);
  const tpSet = bindTypeParams(ctx, stmt.typeParams);
  bindValueParams(ctx, stmt.params, tpSet);
  captureScope(ctx, stmt.span);
  const annotated = resolveTypeNode(ctx, stmt.returnType, tpSet);
  const prevRet = ctx.returnType;
  const prevAsyncFn = ctx.asyncFn;
  const prevInAsync = ctx.inAsync;
  ctx.inAsync = stmt.async;
  if (stmt.async) {
    ctx.asyncFn = true;
    ctx.returnType = asyncReturnInner(ctx, annotated, stmt.returnType.span);
  } else {
    ctx.asyncFn = false;
    ctx.returnType = annotated;
  }
  const definitelyReturns = checkBlock(ctx, stmt.body);
  const checkedReturn = ctx.returnType;
  ctx.returnType = prevRet;
  ctx.asyncFn = prevAsyncFn;
  ctx.inAsync = prevInAsync;
  popScope(ctx);

  if (!isVoid(checkedReturn) && !isNever(checkedReturn) && !definitelyReturns) {
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
      bindValueParams(ctx, m.params, new Set());
      captureScope(ctx, m.span);
      const prevThis = ctx.thisType;
      const prevRet = ctx.returnType;
      const prevAsyncFn = ctx.asyncFn;
      const prevInAsync = ctx.inAsync;
      ctx.thisType = instance;
      ctx.returnType = prim("void");
      ctx.asyncFn = false;
      ctx.inAsync = false;
      checkBlock(ctx, m.body);
      ctx.thisType = prevThis;
      ctx.returnType = prevRet;
      ctx.asyncFn = prevAsyncFn;
      ctx.inAsync = prevInAsync;
      popScope(ctx);
    } else if (m.kind === "method") {
      pushScope(ctx);
      const tpSet = bindTypeParams(ctx, m.typeParams);
      bindValueParams(ctx, m.params, tpSet);
      captureScope(ctx, m.span);
      const annotated = resolveTypeNode(ctx, m.returnType, tpSet);
      const prevThis = ctx.thisType;
      const prevRet = ctx.returnType;
      const prevAsyncFn = ctx.asyncFn;
      const prevInAsync = ctx.inAsync;
      ctx.thisType = instance;
      ctx.inAsync = m.async;
      if (m.async) {
        ctx.asyncFn = true;
        ctx.returnType = asyncReturnInner(ctx, annotated, m.returnType.span);
      } else {
        ctx.asyncFn = false;
        ctx.returnType = annotated;
      }
      const definitelyReturns = checkBlock(ctx, m.body);
      const checkedReturn = ctx.returnType;
      ctx.thisType = prevThis;
      ctx.returnType = prevRet;
      ctx.asyncFn = prevAsyncFn;
      ctx.inAsync = prevInAsync;
      popScope(ctx);
      if (
        !isVoid(checkedReturn) &&
        !isNever(checkedReturn) &&
        !definitelyReturns
      ) {
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
    const bareOk =
      isVoid(ctx.returnType) ||
      (ctx.asyncFn && isUndefinedType(ctx.returnType));
    if (!bareOk) {
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
  if (isVoid(argType) && !isVoid(ctx.returnType) && !ctx.asyncFn) {
    diag(
      ctx,
      "jsv.check.void_value",
      "A 'void' value may only be used as an expression statement or returned from a void function.",
      stmt.argument.span,
    );
    return;
  }
  if (ctx.asyncFn) {
    if (ctx.returnType.kind === "error" || argType.kind === "error") return;
    const wrapped = promiseType(ctx.returnType);
    if (isAssignable(argType, ctx.returnType) || isAssignable(argType, wrapped)) {
      return;
    }
    diag(
      ctx,
      "jsv.check.not_assignable",
      `Type '${typeToString(argType)}' is not assignable to type '${typeToString(ctx.returnType)}' or '${typeToString(wrapped)}'.`,
      stmt.argument.span,
    );
    return;
  }
  checkAssignability(ctx, argType, ctx.returnType, stmt.argument.span);
}

function isUndefinedType(type: Type): boolean {
  const t = unwrap(type);
  return t.kind === "prim" && t.name === "undefined";
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

type ChainInfo = {
  /** Type of the expression, including `undefined` from an open optional chain. */
  type: Type;
  /** Type if every `?.` in the open chain continued. Optional properties still include `undefined`. */
  direct: Type;
  inChain: boolean;
};

function checkExpr(
  ctx: CheckerContext,
  expr: Expr,
  expected: Type | null,
): Type {
  return checkChain(ctx, expr, expected).type;
}

function checkChain(
  ctx: CheckerContext,
  expr: Expr,
  expected: Type | null,
): ChainInfo {
  captureScope(ctx, expr.span);
  const info = finishChain(checkChainBody(ctx, expr, expected), expr);
  if (ctx.typeQuery !== undefined) {
    ctx.typeQuery.hits.push({ span: expr.span, type: info.type });
  }
  return info;
}

function finishChain(info: ChainInfo, expr: Expr): ChainInfo {
  if (
    (expr.kind === "member" || expr.kind === "index" || expr.kind === "call") &&
    expr.stopChain === true
  ) {
    return { type: info.type, direct: info.type, inChain: false };
  }
  return info;
}

function chainCalleeType(info: ChainInfo, optional: boolean): Type {
  if (optional) return stripNullish(info.direct).type;
  if (info.inChain) return info.direct;
  return info.type;
}

function checkChainBody(
  ctx: CheckerContext,
  expr: Expr,
  expected: Type | null,
): ChainInfo {
  switch (expr.kind) {
    case "member":
      return checkMemberChain(ctx, expr);
    case "index":
      return checkIndexChain(ctx, expr);
    case "call":
      return checkCallChain(ctx, expr);
    default: {
      const type = checkExprBody(ctx, expr, expected);
      return { type, direct: type, inChain: false };
    }
  }
}

function stripNullish(type: Type): { type: Type; removed: boolean } {
  if (type.kind === "error") return { type, removed: false };
  const t = unwrap(type);
  if (t.kind === "prim" && (t.name === "null" || t.name === "undefined")) {
    return { type: prim("never"), removed: true };
  }
  if (t.kind === "union") {
    const kept: Type[] = [];
    let removed = false;
    for (const m of t.members) {
      const u = unwrap(m);
      if (u.kind === "prim" && (u.name === "null" || u.name === "undefined")) {
        removed = true;
        continue;
      }
      kept.push(m);
    }
    if (!removed) return { type, removed: false };
    if (kept.length === 0) return { type: prim("never"), removed: true };
    if (kept.length === 1) return { type: kept[0] ?? prim("never"), removed: true };
    return { type: unionType(kept), removed: true };
  }
  return { type, removed: false };
}

function checkExprBody(
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
      return checkCallChain(ctx, expr).type;
    case "member":
      return checkMemberChain(ctx, expr).type;
    case "index":
      return checkIndexChain(ctx, expr).type;
    case "new":
      return checkNew(ctx, expr);
    case "arrow":
      return checkArrow(ctx, expr, expected);
    case "await":
      return checkAwait(ctx, expr);
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

  if (op === "??") {
    const lt = checkExpr(ctx, expr.left, null);
    const rt = checkExpr(ctx, expr.right, null);
    rejectVoidValue(ctx, lt, expr.left.span);
    rejectVoidValue(ctx, rt, expr.right.span);
    if (lt.kind === "error") return rt.kind === "error" ? ERROR_TYPE : rt;
    if (rt.kind === "error") return lt;
    const stripped = stripNullish(lt);
    if (!stripped.removed) return lt;
    if (isNever(stripped.type)) return rt;
    if (typesEqual(stripped.type, rt)) return stripped.type;
    return unionType([stripped.type, rt]);
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

  if (
    (target.kind === "member" || target.kind === "index") &&
    invalidOptionalAssignTarget(target)
  ) {
    diag(
      ctx,
      "jsv.check.invalid_assignment",
      "An optional chain cannot be assigned to.",
      target.span,
      "Close the chain with parentheses before a later property, for example `(obj?.inner).field = value`.",
    );
    checkExpr(ctx, expr.value, null);
    return ERROR_TYPE;
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

function containsSolvedParam(type: Type, solving: Set<string>): boolean {
  switch (type.kind) {
    case "prim":
    case "error":
      return false;
    case "type_param":
      return solving.has(type.name);
    case "array":
      return containsSolvedParam(type.element, solving);
    case "union":
      return type.members.some((m) => containsSolvedParam(m, solving));
    case "object":
      return type.props.some((p) => containsSolvedParam(p.type, solving));
    case "function": {
      const inner = new Set(solving);
      for (const tp of type.typeParams) inner.delete(tp);
      return (
        type.params.some((p) => containsSolvedParam(p.type, inner)) ||
        containsSolvedParam(type.returnType, inner)
      );
    }
    case "ref":
      return type.args.some((a) => containsSolvedParam(a, solving));
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function typesEqual(a: Type, b: Type): boolean {
  if (a === b) return true;
  const left = unwrap(a);
  const right = unwrap(b);
  if (left === right) return true;
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "prim":
      return right.kind === "prim" && left.name === right.name;
    case "error":
      return false;
    case "type_param":
      return right.kind === "type_param" && left.name === right.name;
    case "array":
      return right.kind === "array" && typesEqual(left.element, right.element);
    case "union":
      return (
        right.kind === "union" &&
        left.members.length === right.members.length &&
        left.members.every((m, i) => typesEqual(m, right.members[i]!))
      );
    case "object": {
      if (right.kind !== "object" || left.props.length !== right.props.length) {
        return false;
      }
      return left.props.every((p) => {
        const other = right.props.find((x) => x.name === p.name);
        return (
          other !== undefined &&
          p.optional === other.optional &&
          typesEqual(p.type, other.type)
        );
      });
    }
    case "function":
      if (right.kind !== "function") return false;
      if (left.typeParams.length > 0 || right.typeParams.length > 0) return false;
      if (left.params.length !== right.params.length) return false;
      return (
        left.params.every(
          (p, i) =>
            (p.optional === true) === (right.params[i]!.optional === true) &&
            typesEqual(p.type, right.params[i]!.type),
        ) &&
        typesEqual(left.returnType, right.returnType)
      );
    case "ref":
      if (right.kind !== "ref") return false;
      return (
        left.def === right.def &&
        left.args.length === right.args.length &&
        left.args.every((arg, i) => typesEqual(arg, right.args[i]!))
      );
    default: {
      const _exhaustive: never = left;
      return _exhaustive;
    }
  }
}

function inferBind(
  param: Type,
  arg: Type,
  env: Map<string, Type>,
  solving: Set<string>,
): boolean {
  if (param.kind === "type_param" && solving.has(param.name)) {
    if (arg.kind === "error") return false;
    if (containsSolvedParam(arg, solving)) return false;
    const prev = env.get(param.name);
    if (prev === undefined) {
      env.set(param.name, arg);
      return true;
    }
    return typesEqual(prev, arg);
  }
  if (!containsSolvedParam(param, solving)) return true;

  const left = unwrap(param);
  const right = unwrap(arg);
  if (left.kind === "type_param" && solving.has(left.name)) {
    return inferBind(left, right, env, solving);
  }
  if (right.kind === "error") return false;
  if (left.kind === "array" && right.kind === "array") {
    return inferBind(left.element, right.element, env, solving);
  }
  if (left.kind === "function" && right.kind === "function") {
    if (left.typeParams.length > 0 || right.typeParams.length > 0) return false;
    if (left.params.length !== right.params.length) return false;
    for (let i = 0; i < left.params.length; i++) {
      const lp = left.params[i];
      const rp = right.params[i];
      if (lp === undefined || rp === undefined) return false;
      if (!inferBind(lp.type, rp.type, env, solving)) return false;
    }
    return inferBind(left.returnType, right.returnType, env, solving);
  }
  if (left.kind === "object" && right.kind === "object") {
    for (const prop of left.props) {
      if (!containsSolvedParam(prop.type, solving)) continue;
      const found = right.props.find((x) => x.name === prop.name);
      if (found === undefined) return false;
      if (!inferBind(prop.type, found.type, env, solving)) return false;
    }
    return true;
  }
  if (left.kind === "ref" && right.kind === "ref" && left.def === right.def) {
    if (left.args.length !== right.args.length) return false;
    for (let i = 0; i < left.args.length; i++) {
      const la = left.args[i];
      const ra = right.args[i];
      if (la === undefined || ra === undefined) return false;
      if (!inferBind(la, ra, env, solving)) return false;
    }
    return true;
  }
  return false;
}

function solvedArgs(
  names: readonly string[],
  env: Map<string, Type>,
): string[] | null {
  const args: string[] = [];
  for (const name of names) {
    const type = env.get(name);
    if (type === undefined) return null;
    args.push(typeToString(type));
  }
  return args;
}

function inferCallTypeArgs(
  fn: Extract<Type, { kind: "function" }>,
  argTypes: Type[],
): string[] | null {
  if (fn.typeParams.length === 0 || fn.anyArity === true) return null;
  if (argTypes.length < minArity(fn.params) || argTypes.length > fn.params.length) {
    return null;
  }
  const solving = new Set(fn.typeParams);
  const env = new Map<string, Type>();
  for (let i = 0; i < argTypes.length; i++) {
    const param = fn.params[i];
    const arg = argTypes[i];
    if (param === undefined || arg === undefined) return null;
    if (!inferBind(param.type, arg, env, solving)) return null;
  }
  return solvedArgs(fn.typeParams, env);
}

function inferTypeArgsFromValue(def: TypeDef, value: Type): string[] | null {
  if (def.typeParams.length === 0 || value.kind === "error") return null;
  const solving = new Set(def.typeParams);
  if (
    value.kind === "ref" &&
    value.def === def &&
    value.args.length === def.typeParams.length &&
    value.args.every(
      (a) => a.kind !== "error" && !containsSolvedParam(a, solving),
    )
  ) {
    return value.args.map((a) => typeToString(a));
  }
  const env = new Map<string, Type>();
  if (!inferBind(def.body, value, env, solving)) return null;
  return solvedArgs(def.typeParams, env);
}

function recordTypeArgHint(
  ctx: CheckerContext,
  line: number,
  column: number,
  args: string[] | null,
): void {
  if (ctx.typeArgHints === undefined || args === null) return;
  ctx.typeArgHints.push({ line, column, args });
}

function errorChain(): ChainInfo {
  return { type: ERROR_TYPE, direct: ERROR_TYPE, inChain: false };
}

function chainResult(direct: Type, inChain: boolean): ChainInfo {
  if (direct.kind === "error") return errorChain();
  return {
    type: inChain ? optionalReadType(direct) : direct,
    direct,
    inChain,
  };
}

function checkArguments(
  ctx: CheckerContext,
  params: FnParamType[],
  args: Expr[],
  anyArity: boolean,
  span: Span,
): void {
  if (anyArity) {
    for (const a of args) {
      const t = checkExpr(ctx, a, prim("unknown"));
      rejectVoidValue(ctx, t, a.span);
    }
    return;
  }
  const min = minArity(params);
  const max = params.length;
  if (args.length < min || args.length > max) {
    const expected = min === max ? `${max}` : `${min} to ${max}`;
    diag(
      ctx,
      "jsv.check.argument_count",
      `Expected ${expected} argument(s), got ${args.length}.`,
      span,
    );
  }
  const n = Math.min(args.length, params.length);
  for (let i = 0; i < n; i++) {
    const arg = args[i];
    const param = params[i];
    if (arg === undefined || param === undefined) continue;
    const expected = paramExpected(param);
    const t = checkExpr(ctx, arg, expected);
    rejectVoidValue(ctx, t, arg.span);
    checkAssignability(ctx, t, expected, arg.span);
  }
  for (let i = n; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined) checkExpr(ctx, arg, null);
  }
}

function checkAwait(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "await" }>,
): Type {
  if (!ctx.inAsync) {
    diag(
      ctx,
      "jsv.check.await_outside_async",
      "'await' is only allowed inside an async function.",
      expr.span,
      "Mark the enclosing function with `async` and return `Promise<T>`.",
    );
  }
  const argType = checkExpr(ctx, expr.argument, null);
  const awaited = awaitType(argType);
  rejectVoidValue(ctx, awaited, expr.span);
  return awaited;
}

function invalidOptionalAssignTarget(expr: Expr): boolean {
  if (expr.kind !== "member" && expr.kind !== "index" && expr.kind !== "call") {
    return false;
  }
  if (expr.stopChain === true || expr.optional) return true;
  const inner = expr.kind === "call" ? expr.callee : expr.object;
  if (
    (inner.kind === "member" ||
      inner.kind === "index" ||
      inner.kind === "call") &&
    inner.stopChain === true
  ) {
    return false;
  }
  return invalidOptionalAssignTarget(inner);
}

function checkCallChain(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "call" }>,
): ChainInfo {
  const calleeInfo = checkChain(ctx, expr.callee, null);
  const inChain = expr.optional || calleeInfo.inChain;
  const calleeType = chainCalleeType(calleeInfo, expr.optional);
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
    return errorChain();
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
      const argTypes: Type[] = [];
      for (const a of expr.args) argTypes.push(checkExpr(ctx, a, null));
      recordTypeArgHint(
        ctx,
        expr.callee.span.start.line,
        expr.callee.span.start.column,
        inferCallTypeArgs(fn, argTypes),
      );
      return errorChain();
    }
    if (expr.typeArgs.length !== fn.typeParams.length) {
      diag(
        ctx,
        "jsv.check.type_argument_count",
        `Expected ${fn.typeParams.length} type argument(s), got ${expr.typeArgs.length}.`,
        expr.span,
      );
      for (const a of expr.args) checkExpr(ctx, a, null);
      return errorChain();
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

  const params = fn.params.map((p) => {
    const next: FnParamType = {
      name: p.name,
      type: substitute(p.type, subst),
    };
    if (p.optional === true) next.optional = true;
    return next;
  });
  const returnType = substitute(fn.returnType, subst);
  checkArguments(ctx, params, expr.args, fn.anyArity === true, expr.span);
  return chainResult(returnType, inChain);
}

function memberCursor(
  expr: Extract<Expr, { kind: "member" }>,
  line: number,
  column: number,
): boolean {
  if (containsPosition(expr.propertySpan, line, column)) return true;
  const end = expr.object.span.end;
  const start = expr.propertySpan.start;
  const afterObject =
    line > end.line || (line === end.line && column > end.column);
  const beforeProperty =
    line < start.line || (line === start.line && column < start.column);
  return afterObject && beforeProperty;
}

function noteMember(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "member" }>,
  objectType: Type,
): void {
  const cap = ctx.completion;
  if (cap === undefined) return;
  if (!memberCursor(expr, cap.line, cap.column)) return;
  const extent = spanExtent(cap.source, expr.propertySpan);
  if (cap.memberBest === null || extent < cap.memberBest.extent) {
    cap.memberBest = {
      extent,
      objectType,
      propertySpan: expr.propertySpan,
    };
  }
}

function checkMemberChain(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "member" }>,
): ChainInfo {
  const objInfo = checkChain(ctx, expr.object, null);
  const inChain = expr.optional || objInfo.inChain;
  const base = inChain ? stripNullish(objInfo.direct).type : objInfo.type;
  noteMember(ctx, expr, base);
  const prop = getProperty(base, expr.property);
  if (prop === null) {
    if (base.kind === "error" || objInfo.type.kind === "error") return errorChain();
    const shown = isNever(base) ? objInfo.type : base;
    const known = propertyNames(shown);
    diag(
      ctx,
      "jsv.check.missing_property",
      `Property '${expr.property}' does not exist on type '${typeToString(shown)}'.`,
      expr.propertySpan,
      known.length > 0 ? `Known properties: ${known.join(", ")}` : undefined,
    );
    return errorChain();
  }
  const direct = prop.optional ? optionalReadType(prop.type) : prop.type;
  return chainResult(direct, inChain);
}

function checkIndexChain(
  ctx: CheckerContext,
  expr: Extract<Expr, { kind: "index" }>,
): ChainInfo {
  const objInfo = checkChain(ctx, expr.object, null);
  const inChain = expr.optional || objInfo.inChain;
  const base = inChain ? stripNullish(objInfo.direct).type : objInfo.type;
  const indexType = checkExpr(ctx, expr.index, prim("number"));
  rejectVoidValue(ctx, indexType, expr.index.span);
  const expanded = unwrap(base);
  if (expanded.kind !== "array") {
    if (base.kind !== "error" && objInfo.type.kind !== "error") {
      const shown = isNever(base) ? objInfo.type : base;
      diag(
        ctx,
        "jsv.check.not_indexable",
        `Type '${typeToString(shown)}' is not indexable.`,
        expr.object.span,
      );
    }
    return errorChain();
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
  return chainResult(expanded.element, inChain);
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
      checkArguments(ctx, ctor.params, expr.args, false, expr.span);
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
  const prevAsyncFn = ctx.asyncFn;
  const prevInAsync = ctx.inAsync;
  ctx.thisType = null;
  ctx.inAsync = expr.async;

  const params: FnParamType[] = [];
  for (const p of expr.params) {
    const declared = resolveTypeNode(ctx, p.type);
    const valueType = p.optional ? optionalReadType(declared) : declared;
    declareInScope(
      ctx,
      {
        name: p.name,
        kind: "value",
        origin: "param",
        mutable: true,
        valueType,
      },
      p.nameSpan,
    );
    const param: FnParamType = { name: p.name, type: declared };
    if (p.optional) param.optional = true;
    params.push(param);
  }
  captureScope(ctx, expr.span);

  let returnType: Type;
  if (expr.body.kind === "block") {
    const annotated = expectedFn?.returnType ?? prim("void");
    let declaredRet = annotated;
    const prevRet = ctx.returnType;
    if (expr.async) {
      ctx.asyncFn = true;
      declaredRet =
        expectedFn !== null
          ? asyncReturnInner(ctx, annotated, expr.span)
          : prim("void");
    } else {
      ctx.asyncFn = false;
    }
    ctx.returnType = declaredRet;
    const definitelyReturns = checkBlock(ctx, expr.body);
    ctx.returnType = prevRet;
    if (expr.async) {
      returnType =
        expectedFn !== null && declaredRet.kind !== "error"
          ? annotated
          : promiseType(prim("void"));
    } else {
      returnType = expectedFn !== null ? declaredRet : prim("void");
    }
    const missingAgainst = expr.async ? declaredRet : returnType;
    if (
      expectedFn !== null &&
      !isVoid(missingAgainst) &&
      !isNever(missingAgainst) &&
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
    const annotated = expectedFn?.returnType ?? null;
    let expectedRet = annotated;
    if (expr.async) {
      ctx.asyncFn = true;
      expectedRet =
        annotated !== null ? asyncReturnInner(ctx, annotated, expr.span) : null;
    } else {
      ctx.asyncFn = false;
    }
    const bodyType = checkExpr(ctx, expr.body, expectedRet);
    rejectVoidValue(ctx, bodyType, expr.body.span);
    if (expr.async) {
      if (expectedRet !== null && expectedRet.kind !== "error" && bodyType.kind !== "error") {
        const wrapped = promiseType(expectedRet);
        if (
          !isAssignable(bodyType, expectedRet) &&
          !isAssignable(bodyType, wrapped)
        ) {
          diag(
            ctx,
            "jsv.check.not_assignable",
            `Type '${typeToString(bodyType)}' is not assignable to type '${typeToString(expectedRet)}' or '${typeToString(wrapped)}'.`,
            expr.body.span,
          );
        }
      }
      returnType =
        annotated !== null && expectedRet !== null && expectedRet.kind !== "error"
          ? annotated
          : promiseType(awaitType(bodyType));
    } else {
      returnType = bodyType;
      if (expectedRet !== null) {
        checkAssignability(ctx, returnType, expectedRet, expr.body.span);
        returnType = expectedRet;
      }
    }
  }

  ctx.thisType = prevThis;
  ctx.asyncFn = prevAsyncFn;
  ctx.inAsync = prevInAsync;
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
  checkModule(
    absolute,
    source,
    readFile,
    moduleCache,
    checkingStack,
    options?.typeQuery,
    {
      typecheckPartial: options?.typecheckPartial === true,
      typeArgHints: options?.typeArgHints,
      completion: options?.completion,
    },
  );
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
  return checkSource(source, absolute, { ...options, readFile });
}

export type TypeHit = {
  type: string;
  start: SourcePosition;
  end: SourcePosition;
};

function containsPosition(
  span: Span,
  line: number,
  column: number,
): boolean {
  const afterStart =
    line > span.start.line ||
    (line === span.start.line && column >= span.start.column);
  const beforeEnd =
    line < span.end.line ||
    (line === span.end.line && column <= span.end.column);
  return afterStart && beforeEnd;
}

/** UTF-16 code-unit offset of a 1-based line/column position. */
function positionOffset(source: string, pos: SourcePosition): number {
  let line = 1;
  let column = 1;
  for (let i = 0; i < source.length; i++) {
    if (line === pos.line && column === pos.column) return i;
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  if (line === pos.line && column === pos.column) return source.length;
  return source.length;
}

function spanExtent(source: string, span: Span): number {
  return positionOffset(source, span.end) - positionOffset(source, span.start);
}

export function typeAt(
  source: string,
  file: string,
  line: number,
  column: number,
  options?: CheckOptions,
): { hit: TypeHit | null; diagnostics: Diagnostic[] } {
  const hits: { span: Span; type: Type }[] = [];
  const typeQuery = { line, column, hits };
  const { diagnostics } = checkSource(source, file, {
    ...options,
    typeQuery,
  });

  const containing = hits.filter((h) => containsPosition(h.span, line, column));
  if (containing.length === 0) {
    return { hit: null, diagnostics };
  }

  const hasNonError = containing.some((h) => h.type.kind !== "error");
  const candidates = hasNonError
    ? containing.filter((h) => h.type.kind !== "error")
    : containing;

  // Prefer smallest extent; on a tie prefer the earlier hit (inner node).
  let best = candidates[0]!;
  let bestExtent = spanExtent(source, best.span);
  for (let i = 1; i < candidates.length; i++) {
    const h = candidates[i]!;
    const extent = spanExtent(source, h.span);
    if (extent < bestExtent) {
      best = h;
      bestExtent = extent;
    }
  }

  return {
    hit: {
      type: typeToString(best.type),
      start: best.span.start,
      end: best.span.end,
    },
    diagnostics,
  };
}
