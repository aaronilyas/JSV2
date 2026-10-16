import {
  checkSource,
  type CapturedBinding,
  type CheckOptions,
  type CompletionCapture,
  type MismatchHint,
} from "../checker/check.ts";
import { createDomLibModule } from "../checker/dom-lib.ts";
import {
  expand,
  getProperty,
  isAssignable,
  isUnknown,
  prim,
  typeToString,
  unwrap,
  type Type,
  type TypeDef,
} from "../checker/types.ts";
import type { Diagnostic, SourcePosition } from "../diagnostics.ts";
import type {
  Block,
  Expr,
  ImportStmt,
  Param,
  Program,
  Span,
  Statement,
  TypeNode,
  VarStmt,
} from "../parser/ast.ts";
import { parse } from "../parser/parse.ts";
import { domAnalyze } from "./dom-analyze.ts";

export type TextEdit = {
  start: SourcePosition;
  end: SourcePosition;
  newText: string;
};

const PRIM_TYPE_NAMES = [
  "string",
  "number",
  "boolean",
  "null",
  "void",
  "never",
  "unknown",
  "undefined",
] as const;

export function suggestFix(
  source: string,
  file: string,
  code: string,
  line: number,
  column: number,
  options?: CheckOptions,
): {
  applicable: boolean;
  edits: TextEdit[];
  message: string;
  diagnostics: Diagnostic[];
} {
  const typeArgHints: CheckOptions["typeArgHints"] = [];
  const mismatchHints: MismatchHint[] = [];
  const completion: CompletionCapture = {
    line,
    column,
    source,
    scopeBest: null,
    memberBest: null,
  };
  const { diagnostics } = checkSource(source, file, {
    ...options,
    typeArgHints,
    mismatchHints,
    completion,
  });

  if (code.startsWith("jsv.dom.")) {
    return suggestDomFix(source, file, code, line, column, diagnostics, options);
  }

  const match = diagnostics.find(
    (d) =>
      d.code === code &&
      d.start !== undefined &&
      d.start.line === line &&
      d.start.column === column,
  );

  if (match === undefined) {
    return {
      applicable: false,
      edits: [],
      message: "No matching diagnostic at that position.",
      diagnostics,
    };
  }

  if (
    match.code === "jsv.parse.unexpected_token" &&
    match.message.includes("expected `;`") &&
    match.start !== undefined
  ) {
    if (!semicolonIsObvious(source, match.start)) {
      return notFixable(code, diagnostics);
    }
    return {
      applicable: true,
      edits: [
        {
          start: match.start,
          end: match.start,
          newText: ";",
        },
      ],
      message: "Insert `;` before the unexpected token.",
      diagnostics,
    };
  }

  if (
    match.code === "jsv.parse.unexpected_token" &&
    (match.message === "function return type is required" ||
      match.message === "method return type is required") &&
    match.start !== undefined
  ) {
    const { program } = parse(source, file);
    const edit = returnTypeEdit(program, match, diagnostics);
    if (edit !== null) {
      return {
        applicable: true,
        edits: [edit],
        message: `Insert return type '${edit.newText.trim()}'.`,
        diagnostics,
      };
    }
  }

  if (match.code === "jsv.check.missing_type_arguments" && match.end !== undefined) {
    const hint = typeArgHints?.find((h) => h.line === line && h.column === column);
    if (hint === undefined) {
      return notFixable(code, diagnostics);
    }
    const insert = after(match.end);
    const printed = hint.args.join(", ");
    return {
      applicable: true,
      edits: [
        {
          start: insert,
          end: insert,
          newText: `<${printed}>`,
        },
      ],
      message: `Insert type arguments <${printed}>.`,
      diagnostics,
    };
  }

  if (match.code === "jsv.check.unresolved_name" && match.start !== undefined && match.end !== undefined) {
    const name = sourceSlice(source, match.start, match.end);
    const { program } = parse(source, file);
    const use = findUse(program, line, column);
    if (use === null || use.name !== name) {
      return notFixable(code, diagnostics);
    }
    const bindings = completion.scopeBest?.bindings ?? [];
    const importEdit = domImportEdit(source, program, name, use.kind);
    const typo = classifyTypo(name, use.kind, bindings);
    const domTypo = uniqueDomTypo(name, use.kind);
    if (typo.ambiguous || (domTypo !== null && typo.unique !== null) || (domTypo !== null && importEdit !== null) || (typo.unique !== null && importEdit !== null)) {
      return {
        applicable: false,
        edits: [],
        message: "Multiple possible fixes; not applying one.",
        diagnostics,
      };
    }
    if (importEdit !== null) {
      return {
        applicable: true,
        edits: [importEdit],
        message: `Import '${name}' from "jsv/dom".`,
        diagnostics,
      };
    }
    if (typo.unique !== null) {
      return {
        applicable: true,
        edits: [
          {
            start: match.start,
            end: after(match.end),
            newText: typo.unique,
          },
        ],
        message: `Replace '${name}' with '${typo.unique}'.`,
        diagnostics,
      };
    }
    if (domTypo !== null) {
      const fixed = domTypoFix(
        source,
        program,
        name,
        domTypo,
        use.kind,
        match.start,
        match.end,
      );
      if (fixed !== null) {
        return { ...fixed, diagnostics };
      }
    }
  }

  const { program } = parse(source, file);
  const extra = extraFix(source, program, match, mismatchHints);
  if (
    extra !== null &&
    confirmsFix(source, file, match.code, diagnostics, extra.edits, options)
  ) {
    return { ...extra, diagnostics };
  }

  return notFixable(code, diagnostics);
}

function notFixable(
  code: string,
  diagnostics: Diagnostic[],
): {
  applicable: boolean;
  edits: TextEdit[];
  message: string;
  diagnostics: Diagnostic[];
} {
  return {
    applicable: false,
    edits: [],
    message: `Diagnostic code '${code}' is not auto-fixable.`,
    diagnostics,
  };
}

function after(pos: SourcePosition): SourcePosition {
  return { line: pos.line, column: pos.column + 1 };
}

function sourceSlice(
  source: string,
  start: SourcePosition,
  endInclusive: SourcePosition,
): string {
  const from = indexAt(source, start);
  const to = indexAt(source, endInclusive);
  if (from < 0 || to < from) return "";
  return source.slice(from, to + 1);
}

function indexAt(source: string, pos: SourcePosition): number {
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
  return -1;
}

function positionAt(source: string, index: number): SourcePosition {
  let line = 1;
  let column = 1;
  const stop = Math.min(index, source.length);
  for (let i = 0; i < stop; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function contains(span: Span, line: number, column: number): boolean {
  const afterStart =
    line > span.start.line ||
    (line === span.start.line && column >= span.start.column);
  const beforeEnd =
    line < span.end.line ||
    (line === span.end.line && column <= span.end.column);
  return afterStart && beforeEnd;
}

function spanExtent(span: Span): number {
  if (span.start.line !== span.end.line) {
    return (span.end.line - span.start.line) * 10000 + span.end.column;
  }
  return span.end.column - span.start.column;
}

type NameUse = { kind: "value" | "type"; name: string; span: Span };

function findUse(program: Program, line: number, column: number): NameUse | null {
  let best: NameUse | null = null;
  const consider = (use: NameUse): void => {
    if (!contains(use.span, line, column)) return;
    if (best === null || spanExtent(use.span) < spanExtent(best.span)) {
      best = use;
    }
  };
  const walkType = (node: TypeNode): void => {
    switch (node.kind) {
      case "prim":
        return;
      case "named":
        consider({ kind: "type", name: node.name, span: node.nameSpan });
        for (const arg of node.args) walkType(arg);
        return;
      case "array":
        walkType(node.element);
        return;
      case "union":
        for (const t of node.types) walkType(t);
        return;
      case "object":
        for (const m of node.members) {
          if (m.kind === "prop") walkType(m.type);
          else {
            for (const p of m.params) walkType(p.type);
            walkType(m.returnType);
          }
        }
        return;
      case "function":
        for (const p of node.params) walkType(p.type);
        walkType(node.returnType);
        return;
      default: {
        const _exhaustive: never = node;
        return _exhaustive;
      }
    }
  };
  const walkExpr = (expr: Expr): void => {
    switch (expr.kind) {
      case "number":
      case "string":
      case "boolean":
      case "null":
      case "undefined":
        return;
      case "ident":
        consider({ kind: "value", name: expr.name, span: expr.span });
        return;
      case "template":
        for (const part of expr.parts) {
          if (part.kind === "expr") walkExpr(part.expr);
        }
        return;
      case "array":
        for (const el of expr.elements) walkExpr(el);
        return;
      case "object":
        for (const p of expr.properties) walkExpr(p.value);
        return;
      case "unary":
        walkExpr(expr.argument);
        return;
      case "binary":
        walkExpr(expr.left);
        walkExpr(expr.right);
        return;
      case "assign":
        walkExpr(expr.target);
        walkExpr(expr.value);
        return;
      case "ternary":
        walkExpr(expr.test);
        walkExpr(expr.consequent);
        walkExpr(expr.alternate);
        return;
      case "call":
        walkExpr(expr.callee);
        for (const t of expr.typeArgs) walkType(t);
        for (const a of expr.args) walkExpr(a);
        return;
      case "member":
        walkExpr(expr.object);
        return;
      case "index":
        walkExpr(expr.object);
        walkExpr(expr.index);
        return;
      case "new":
        walkExpr(expr.callee);
        for (const t of expr.typeArgs) walkType(t);
        for (const a of expr.args) walkExpr(a);
        return;
      case "arrow":
        for (const p of expr.params) walkType(p.type);
        if (expr.body.kind === "block") walkBlock(expr.body.body);
        else walkExpr(expr.body);
        return;
      case "assert":
        walkExpr(expr.expression);
        walkType(expr.type);
        return;
      default: {
        const _exhaustive: never = expr;
        return _exhaustive;
      }
    }
  };
  const walkStmt = (stmt: Statement): void => {
    switch (stmt.kind) {
      case "import":
      case "empty":
        return;
      case "var":
        if (stmt.type !== null) walkType(stmt.type);
        if (stmt.init !== null) walkExpr(stmt.init);
        return;
      case "function":
        for (const p of stmt.params) walkType(p.type);
        walkType(stmt.returnType);
        walkBlock(stmt.body.body);
        return;
      case "type_alias":
        walkType(stmt.type);
        return;
      case "interface":
        for (const m of stmt.members) {
          if (m.kind === "prop") walkType(m.type);
          else {
            for (const p of m.params) walkType(p.type);
            walkType(m.returnType);
          }
        }
        return;
      case "class":
        for (const m of stmt.members) {
          if (m.kind === "field") walkType(m.type);
          else if (m.kind === "constructor") {
            for (const p of m.params) walkType(p.type);
            walkBlock(m.body.body);
          } else {
            for (const p of m.params) walkType(p.type);
            walkType(m.returnType);
            walkBlock(m.body.body);
          }
        }
        return;
      case "if":
        walkExpr(stmt.test);
        walkStmt(stmt.consequent);
        if (stmt.alternate !== null) walkStmt(stmt.alternate);
        return;
      case "while":
        walkExpr(stmt.test);
        walkStmt(stmt.body);
        return;
      case "for":
        if (stmt.init !== null) {
          if (stmt.init.kind === "var") walkStmt(stmt.init);
          else walkExpr(stmt.init);
        }
        if (stmt.test !== null) walkExpr(stmt.test);
        if (stmt.update !== null) walkExpr(stmt.update);
        walkStmt(stmt.body);
        return;
      case "return":
        if (stmt.argument !== null) walkExpr(stmt.argument);
        return;
      case "block":
        walkBlock(stmt.body);
        return;
      case "expr_stmt":
        walkExpr(stmt.expression);
        return;
      default: {
        const _exhaustive: never = stmt;
        return _exhaustive;
      }
    }
  };
  const walkBlock = (body: Statement[]): void => {
    for (const stmt of body) walkStmt(stmt);
  };
  walkBlock(program.body);
  return best;
}

function classifyTypo(
  name: string,
  use: "value" | "type",
  bindings: readonly CapturedBinding[],
): { unique: string | null; ambiguous: boolean } {
  const names = new Set<string>();
  for (const binding of bindings) {
    if (binding.name === name) continue;
    const visible =
      use === "value"
        ? binding.kind === "value" || binding.kind === "both"
        : binding.kind === "type" || binding.kind === "both";
    if (visible) names.add(binding.name);
  }
  if (use === "type") {
    for (const prim of PRIM_TYPE_NAMES) names.add(prim);
  }
  let chosen: string | null = null;
  let count = 0;
  for (const candidate of names) {
    if (editDistance(name, candidate) !== 1) continue;
    count += 1;
    chosen = candidate;
  }
  if (count > 1) return { unique: null, ambiguous: true };
  return { unique: chosen, ambiguous: false };
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const m = a.length;
  const n = b.length;
  const dp: number[][] = [];
  for (let i = 0; i <= m; i++) {
    const row: number[] = [];
    for (let j = 0; j <= n; j++) row.push(0);
    dp.push(row);
  }
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      let value = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      );
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        value = Math.min(value, dp[i - 2]![j - 2]! + 1);
      }
      dp[i]![j] = value;
    }
  }
  return dp[m]![n]!;
}

function domExportMatches(name: string, use: "value" | "type"): boolean {
  const mod = createDomLibModule();
  const value = mod.namedValues.get(name);
  const type = mod.namedTypes.get(name);
  if (use === "value") return value !== undefined;
  return type !== undefined;
}

function domImportEdit(
  source: string,
  program: Program,
  name: string,
  use: "value" | "type",
): TextEdit | null {
  if (!domExportMatches(name, use)) return null;
  const imports = program.body.filter(
    (stmt): stmt is ImportStmt =>
      stmt.kind === "import" && stmt.moduleSpecifier === "jsv/dom",
  );
  if (
    imports.some((stmt) =>
      stmt.names.some((n) => n.imported === name || n.local === name),
    )
  ) {
    return null;
  }
  const host = imports.find((stmt) => stmt.names.length > 0) ?? imports[0];
  if (host === undefined) {
    const at = { line: 1, column: 1 };
    return {
      start: at,
      end: at,
      newText: `import { ${name} } from "jsv/dom";\n`,
    };
  }
  if (host.names.length > 0) {
    const last = host.names[host.names.length - 1]!;
    const insert = after(last.span.end);
    return {
      start: insert,
      end: insert,
      newText: `, ${name}`,
    };
  }
  const start = indexAt(source, host.span.start);
  const end = indexAt(source, host.span.end);
  if (start < 0 || end < start) return null;
  const text = source.slice(start, end + 1);
  const open = text.indexOf("{");
  const close = text.indexOf("}");
  if (open < 0 || close < open) {
    const at = { line: 1, column: 1 };
    return {
      start: at,
      end: at,
      newText: `import { ${name} } from "jsv/dom";\n`,
    };
  }
  const interior = text.slice(open + 1, close);
  if (interior.trim() !== "") return null;
  return {
    start: positionAt(source, start + open + 1),
    end: positionAt(source, start + close),
    newText: ` ${name} `,
  };
}

const STATEMENT_START = new Set([
  "let",
  "const",
  "function",
  "return",
  "if",
  "while",
  "for",
  "type",
  "interface",
  "class",
  "import",
  "export",
  "else",
]);

type SimpleType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "undefined"
  | "void";

type FnLike = {
  span: Span;
  nameSpan: Span | null;
  params: Param[];
  returnType: TypeNode | null;
  body: Expr | Block;
};

type FixHit = {
  applicable: true;
  edits: TextEdit[];
  message: string;
};

function semicolonIsObvious(source: string, pos: SourcePosition): boolean {
  if (pos.column === 1) return true;
  const token = readToken(source, pos);
  if (token === "}") return true;
  return STATEMENT_START.has(token);
}

function readToken(source: string, pos: SourcePosition): string {
  const i = indexAt(source, pos);
  if (i < 0 || i >= source.length) return "";
  const ch = source[i] ?? "";
  if (!/[A-Za-z_]/.test(ch)) return ch;
  let j = i + 1;
  while (j < source.length && /[A-Za-z0-9_]/.test(source[j] ?? "")) j += 1;
  return source.slice(i, j);
}

function uniqueDomTypo(name: string, use: "value" | "type"): string | null {
  const mod = createDomLibModule();
  const names =
    use === "value"
      ? [...mod.namedValues.keys()]
      : [...mod.namedTypes.keys()];
  let chosen: string | null = null;
  for (const candidate of names) {
    if (candidate === name) continue;
    // `h` is one edit away from every short token. Require a real name.
    if (name.length < 3 || candidate.length < 3) continue;
    if (editDistance(name, candidate) !== 1) continue;
    if (chosen !== null) return null;
    chosen = candidate;
  }
  return chosen;
}

function importedLocal(program: Program, imported: string): string | null {
  for (const stmt of program.body) {
    if (stmt.kind !== "import" || stmt.moduleSpecifier !== "jsv/dom") continue;
    for (const spec of stmt.names) {
      if (spec.imported === imported) return spec.local;
    }
  }
  return null;
}

function domTypoFix(
  source: string,
  program: Program,
  name: string,
  domTypo: string,
  use: "value" | "type",
  start: SourcePosition,
  end: SourcePosition,
): FixHit | null {
  const local = importedLocal(program, domTypo);
  if (local !== null && local !== domTypo) return null;
  const rename: TextEdit = {
    start,
    end: after(end),
    newText: domTypo,
  };
  if (local === domTypo) {
    return {
      applicable: true,
      edits: [rename],
      message: `Replace '${name}' with '${domTypo}'.`,
    };
  }
  const imp = domImportEdit(source, program, domTypo, use);
  if (imp === null) return null;
  return {
    applicable: true,
    edits: [rename, imp],
    message: `Import '${domTypo}' from "jsv/dom" and replace '${name}'.`,
  };
}

function suggestDomFix(
  source: string,
  file: string,
  code: string,
  line: number,
  column: number,
  diagnostics: Diagnostic[],
  options: CheckOptions | undefined,
): {
  applicable: boolean;
  edits: TextEdit[];
  message: string;
  diagnostics: Diagnostic[];
} {
  const issue = domAnalyze(source, file).issues.find(
    (item) =>
      item.code === code &&
      item.start?.line === line &&
      item.start?.column === column,
  );
  if (issue === undefined) {
    return {
      applicable: false,
      edits: [],
      message: "No matching diagnostic at that position.",
      diagnostics,
    };
  }
  if (code === "jsv.dom.effect_should_be_computed") {
    const hit = effectToComputed(source, file, line, column, diagnostics, options);
    if (hit !== null) return { ...hit, diagnostics };
  }
  return notFixable(code, diagnostics);
}

function effectToComputed(
  source: string,
  file: string,
  line: number,
  column: number,
  before: Diagnostic[],
  options: CheckOptions | undefined,
): FixHit | null {
  const { program } = parse(source, file);
  const locals = domLocals(program);
  const effect = findEffectDerivation(program, locals.effect, line, column);
  if (effect === null) return null;
  if (identUsed(effect.value, effect.target)) return null;
  if (!valueIsReads(effect.value)) return null;
  if (writeCount(program, effect.target) !== 1) return null;
  const decl = findSignalDecl(program, effect.target, locals.signal);
  if (decl === null || decl.init === null || decl.init.kind !== "call") {
    return null;
  }
  const typeArgs = typeArgSource(source, decl.init);
  const valueText = sourceSlice(source, effect.value.span.start, effect.value.span.end);
  if (typeArgs === null || valueText === "") return null;
  const localComputed = importedLocal(program, "computed");
  const computedName = localComputed ?? "computed";
  const edits: TextEdit[] = [
    replaceSpan(
      decl.init.span,
      `${computedName}${typeArgs}(() => { return ${valueText}; })`,
    ),
    deleteThroughNewline(source, effect.stmt.span),
  ];
  if (localComputed === null) {
    const imp = domImportEdit(source, program, "computed", "value");
    if (imp === null) return null;
    edits.push(imp);
  }
  if (editsOverlap(source, edits)) return null;
  const after = checkSource(applyEdits(source, edits), file, options).diagnostics;
  if (after.length > before.length || !isMessageSubset(after, before)) return null;
  return {
    applicable: true,
    edits,
    message: `Replace signal '${effect.target}' and the effect with computed${typeArgs}.`,
  };
}

function extraFix(
  source: string,
  program: Program,
  match: Diagnostic,
  hints: readonly MismatchHint[],
): FixHit | null {
  if (match.start === undefined || match.end === undefined) return null;
  if (match.code === "jsv.check.missing_property") {
    const edit = propertyTypoEdit(source, match);
    if (edit === null) return null;
    return {
      applicable: true,
      edits: [edit.edit],
      message: `Replace '${edit.from}' with '${edit.to}'.`,
    };
  }
  if (match.code === "jsv.check.missing_return") {
    const expr = findMissingReturnExpr(program, match.start, match.end);
    if (expr === null) return null;
    return {
      applicable: true,
      edits: [
        {
          start: expr.span.start,
          end: expr.span.start,
          newText: "return ",
        },
      ],
      message: "Insert `return`.",
    };
  }
  if (match.code === "jsv.check.unexpected_type_arguments") {
    const expr = findExpr(program, match.start, match.end);
    if (expr === null) return null;
    if (expr.expr.kind !== "call" && expr.expr.kind !== "new") return null;
    const edit = removeTypeArgsEdit(source, expr.expr);
    if (edit === null) return null;
    return {
      applicable: true,
      edits: [edit],
      message: "Remove unexpected type arguments.",
    };
  }

  const hint = hintFor(hints, match);
  if (hint === null) return null;
  if (match.code === "jsv.check.assign_const") {
    return assignConstFix(source, program, match.start, match.end, hint);
  }
  if (
    match.code !== "jsv.check.not_assignable" &&
    match.code !== "jsv.check.condition_not_boolean" &&
    match.code !== "jsv.check.bad_operator"
  ) {
    return null;
  }
  const hit = findExpr(program, match.start, match.end);
  if (hit === null) return null;
  if (match.code === "jsv.check.bad_operator") {
    const edits = operatorEdits(source, hit.expr, hint);
    if (edits === null) return null;
    return {
      applicable: true,
      edits,
      message: "Read the signal with `.get()` so the operator applies.",
    };
  }
  const wrapped = wrapOrCastEdits(source, hit.expr, hint, hit.annotatedInit);
  if (wrapped === null) return null;
  return {
    applicable: true,
    edits: wrapped.map((edit) => ({
      start: edit.start,
      end: edit.end,
      newText: edit.newText,
    })),
    message: wrapped[0]?.message ?? "Apply the type fix.",
  };
}

function hintFor(
  hints: readonly MismatchHint[],
  match: Diagnostic,
): MismatchHint | null {
  if (match.start === undefined || match.end === undefined) return null;
  const found = hints.filter(
    (hint) =>
      hint.code === match.code &&
      hint.line === match.start?.line &&
      hint.column === match.start?.column &&
      hint.endLine === match.end?.line &&
      hint.endColumn === match.end?.column,
  );
  if (found.length !== 1) return null;
  return found[0] ?? null;
}

function confirmsFix(
  source: string,
  file: string,
  code: string,
  before: readonly Diagnostic[],
  edits: readonly TextEdit[],
  options: CheckOptions | undefined,
): boolean {
  const after = checkSource(applyEdits(source, edits), file, options).diagnostics;
  if (!isMessageSubset(after, before)) return false;
  const count = (list: readonly Diagnostic[]) =>
    list.filter((item) => item.code === code).length;
  return count(after) < count(before);
}

function isMessageSubset(
  after: readonly Diagnostic[],
  before: readonly Diagnostic[],
): boolean {
  const counts = new Map<string, number>();
  for (const item of before) {
    const key = `${item.code}\0${item.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const item of after) {
    const key = `${item.code}\0${item.message}`;
    const left = counts.get(key) ?? 0;
    if (left <= 0) return false;
    counts.set(key, left - 1);
  }
  return true;
}

function applyEdits(source: string, edits: readonly TextEdit[]): string {
  const spans = edits.map((edit) => ({
    start: indexAt(source, edit.start),
    end: indexAt(source, edit.end),
    text: edit.newText,
  }));
  if (spans.some((span) => span.start < 0 || span.end < span.start)) return source;
  spans.sort((a, b) => b.start - a.start);
  let out = source;
  for (const span of spans) {
    out = out.slice(0, span.start) + span.text + out.slice(span.end);
  }
  return out;
}

function signalRead(type: Type): { inner: Type; writable: boolean } | null {
  let current = type;
  const seen = new Set<TypeDef>();
  while (current.kind === "ref") {
    if (seen.has(current.def)) return null;
    seen.add(current.def);
    if (
      (current.def.name === "Signal" || current.def.name === "Computed") &&
      current.args.length >= 1
    ) {
      const get = getProperty(current, "get");
      if (get === null) return null;
      const fn = unwrap(get.type);
      if (fn.kind !== "function" || fn.params.length !== 0) return null;
      const set = getProperty(current, "set");
      return {
        inner: fn.returnType,
        writable: current.def.name === "Signal" && set !== null,
      };
    }
    current = expand(current);
  }
  return null;
}

function zeroArgReturn(type: Type): Type | null {
  const fn = unwrap(type);
  if (fn.kind !== "function" || fn.anyArity === true) return null;
  if (fn.params.length !== 0 || fn.typeParams.length !== 0) return null;
  return fn.returnType;
}

type OpFix = "none" | "get" | "call";

function wrapOrCastEdits(
  source: string,
  expr: Expr,
  hint: MismatchHint,
  annotatedInit: boolean,
): Array<TextEdit & { message?: string }> | null {
  const read = signalRead(hint.source);
  if (read !== null && isAssignable(read.inner, hint.target)) {
    return [{ ...appendGet(source, expr), message: "Insert `.get()` to read the signal." }];
  }
  const ret = zeroArgReturn(hint.source);
  const getMember = expr.kind === "member" && expr.property === "get";
  if (
    ret !== null &&
    (getMember || !annotatedInit) &&
    (expr.kind === "ident" || expr.kind === "member") &&
    isAssignable(ret, hint.target)
  ) {
    return [
      {
        ...appendText(expr, "()"),
        message: getMember ? "Call `.get()`." : "Call the function.",
      },
    ];
  }
  if (!annotatedInit) {
    const literal = literalText(expr, hint.target);
    if (literal !== null) {
      return [
        {
          ...replaceSpan(expr.span, literal),
          message: `Change the literal to ${literal}.`,
        },
      ];
    }
  }
  if (isUnknown(hint.source) && hint.target.kind !== "error" && !isUnknown(hint.target)) {
    const text = atomText(source, expr);
    const printed = typeToString(hint.target);
    return [
      {
        ...replaceSpan(expr.span, `${text} as ${printed}`),
        message: `Assert as ${printed}.`,
      },
    ];
  }
  return null;
}

function operatorEdits(
  source: string,
  expr: Expr,
  hint: MismatchHint,
): TextEdit[] | null {
  if (hint.op === "-" && expr.kind === "unary" && hint.left !== undefined) {
    const choice = operandChoice(hint.left, expr.argument, prim("number"));
    if (choice === null || choice === "none") return null;
    return [operandEdit(source, expr.argument, choice)];
  }
  if (
    expr.kind !== "binary" ||
    hint.left === undefined ||
    hint.right === undefined ||
    hint.op === undefined
  ) {
    return null;
  }
  const choice = uniqueOperandFix(expr, hint.op, hint.left, hint.right);
  if (choice === null) return null;
  const edits: TextEdit[] = [];
  if (choice.left !== "none") edits.push(operandEdit(source, expr.left, choice.left));
  if (choice.right !== "none") {
    edits.push(operandEdit(source, expr.right, choice.right));
  }
  return edits.length > 0 ? edits : null;
}

function operandChoice(type: Type, expr: Expr, needed: Type): OpFix | null {
  if (isAssignable(type, needed)) return "none";
  const read = signalRead(type);
  if (read !== null && isAssignable(read.inner, needed)) return "get";
  const ret = zeroArgReturn(type);
  if (
    ret !== null &&
    (expr.kind === "ident" || expr.kind === "member") &&
    isAssignable(ret, needed)
  ) {
    return "call";
  }
  return null;
}

function uniqueOperandFix(
  expr: Extract<Expr, { kind: "binary" }>,
  op: string,
  left: Type,
  right: Type,
): { left: OpFix; right: OpFix } | null {
  const leftOpts = operandOptions(left, expr.left);
  const rightOpts = operandOptions(right, expr.right);
  let best: { left: OpFix; right: OpFix; cost: number } | null = null;
  let tie = false;
  for (const l of leftOpts) {
    for (const r of rightOpts) {
      if (!binaryAccepts(op, l.type, r.type)) continue;
      const cost = (l.fix === "none" ? 0 : 1) + (r.fix === "none" ? 0 : 1);
      if (cost === 0) continue;
      if (best === null || cost < best.cost) {
        best = { left: l.fix, right: r.fix, cost };
        tie = false;
      } else if (
        cost === best.cost &&
        (l.fix !== best.left || r.fix !== best.right)
      ) {
        tie = true;
      }
    }
  }
  if (best === null || tie) return null;
  return { left: best.left, right: best.right };
}

function operandOptions(
  type: Type,
  expr: Expr,
): { fix: OpFix; type: Type }[] {
  const out: { fix: OpFix; type: Type }[] = [{ fix: "none", type }];
  const read = signalRead(type);
  if (read !== null) out.push({ fix: "get", type: read.inner });
  const ret = zeroArgReturn(type);
  if (ret !== null && (expr.kind === "ident" || expr.kind === "member")) {
    out.push({ fix: "call", type: ret });
  }
  return out;
}

function binaryAccepts(op: string, left: Type, right: Type): boolean {
  if (left.kind === "error" || right.kind === "error") return false;
  if (op === "+") {
    if (isAssignable(left, prim("number")) && isAssignable(right, prim("number"))) {
      return true;
    }
    const leftStr = isAssignable(left, prim("string"));
    const rightStr = isAssignable(right, prim("string"));
    const leftNum = isAssignable(left, prim("number"));
    const rightNum = isAssignable(right, prim("number"));
    return (
      (leftStr || leftNum) &&
      (rightStr || rightNum) &&
      (leftStr || rightStr)
    );
  }
  if (
    op === "-" ||
    op === "*" ||
    op === "/" ||
    op === "%" ||
    op === "<" ||
    op === ">" ||
    op === "<=" ||
    op === ">="
  ) {
    return (
      isAssignable(left, prim("number")) && isAssignable(right, prim("number"))
    );
  }
  return false;
}

function operandEdit(source: string, expr: Expr, fix: OpFix): TextEdit {
  if (fix === "get") return appendGet(source, expr);
  return appendText(expr, "()");
}

function appendGet(source: string, expr: Expr): TextEdit {
  const text = sourceSlice(source, expr.span.start, expr.span.end);
  if (isWrapped(text) || isAtom(expr)) return appendText(expr, ".get()");
  return replaceSpan(expr.span, `(${text}).get()`);
}

function appendText(expr: Expr, text: string): TextEdit {
  const at = after(expr.span.end);
  return { start: at, end: at, newText: text };
}

function replaceSpan(span: Span, newText: string): TextEdit {
  return { start: span.start, end: after(span.end), newText };
}

function isAtom(expr: Expr): boolean {
  switch (expr.kind) {
    case "ident":
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "undefined":
    case "call":
    case "member":
    case "index":
    case "new":
    case "assert":
    case "array":
    case "object":
    case "template":
      return true;
    default:
      return false;
  }
}

function atomText(source: string, expr: Expr): string {
  const text = sourceSlice(source, expr.span.start, expr.span.end);
  if (isWrapped(text) || isAtom(expr)) return text;
  return `(${text})`;
}

function isWrapped(text: string): boolean {
  if (!text.startsWith("(") || !text.endsWith(")")) return false;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    if (depth === 0 && i !== text.length - 1) return false;
  }
  return depth === 0;
}

function literalText(expr: Expr, target: Type): string | null {
  const prims = new Set(primitiveTargets(target));
  if (prims.size !== 1) return null;
  const options: string[] = [];
  if (expr.kind === "number" && prims.has("string")) {
    options.push(JSON.stringify(expr.raw));
  }
  if (expr.kind === "boolean" && prims.has("string")) {
    options.push(expr.value ? '"true"' : '"false"');
  }
  if (
    expr.kind === "string" &&
    prims.has("number") &&
    canonicalNumber(expr.value)
  ) {
    options.push(expr.value);
  }
  if (options.length !== 1) return null;
  return options[0] ?? null;
}

function primitiveTargets(type: Type): string[] {
  const out: string[] = [];
  const visit = (current: Type, seen: Set<TypeDef>): void => {
    if (current.kind === "ref") {
      if (seen.has(current.def)) return;
      seen.add(current.def);
      if (current.def.name === "Signal" || current.def.name === "Computed") {
        return;
      }
      visit(expand(current), seen);
      return;
    }
    if (current.kind === "union") {
      for (const member of current.members) visit(member, seen);
      return;
    }
    if (current.kind === "prim" && !out.includes(current.name)) out.push(current.name);
  };
  visit(type, new Set());
  return out;
}

function canonicalNumber(text: string): boolean {
  return /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(text);
}

function assignConstFix(
  source: string,
  program: Program,
  start: SourcePosition,
  end: SourcePosition,
  hint: MismatchHint,
): FixHit | null {
  const assign = findAssign(program, start, end);
  if (assign === null || assign.target.kind !== "ident") return null;
  const read = signalRead(hint.target);
  if (
    read?.writable === true &&
    isAssignable(hint.source, read.inner) &&
    !isAssignable(hint.source, hint.target)
  ) {
    const value = sourceSlice(source, assign.value.span.start, assign.value.span.end);
    return {
      applicable: true,
      edits: [replaceSpan(assign.span, `${assign.target.name}.set(${value})`)],
      message: `Write the signal with '${assign.target.name}.set(...)'.`,
    };
  }
  if (read !== null) return null;
  if (hint.source.kind === "error" || !isAssignable(hint.source, hint.target)) {
    return null;
  }
  const decl = findOnlyConst(program, assign.target.name, start);
  if (decl === null) return null;
  const keywordEnd = {
    line: decl.span.start.line,
    column: decl.span.start.column + 4,
  };
  if (sourceSlice(source, decl.span.start, keywordEnd) !== "const") return null;
  return {
    applicable: true,
    edits: [
      {
        start: decl.span.start,
        end: {
          line: decl.span.start.line,
          column: decl.span.start.column + 5,
        },
        newText: "let",
      },
    ],
    message: "Change `const` to `let`.",
  };
}

function propertyTypoEdit(
  source: string,
  match: Diagnostic,
): { edit: TextEdit; from: string; to: string } | null {
  const hint = match.hint;
  if (hint === undefined || !hint.startsWith("Known properties: ")) return null;
  if (match.start === undefined || match.end === undefined) return null;
  const props = hint
    .slice("Known properties: ".length)
    .split(", ")
    .filter((name) => name.length > 0);
  const written = sourceSlice(source, match.start, match.end);
  let chosen: string | null = null;
  for (const prop of props) {
    if (prop === written || editDistance(written, prop) !== 1) continue;
    if (chosen !== null) return null;
    chosen = prop;
  }
  if (chosen === null) return null;
  return {
    edit: {
      start: match.start,
      end: after(match.end),
      newText: chosen,
    },
    from: written,
    to: chosen,
  };
}

function returnTypeEdit(
  program: Program,
  match: Diagnostic,
  diagnostics: readonly Diagnostic[],
): TextEdit | null {
  if (match.start === undefined) return null;
  const fn = findReturnTypeTarget(program, match.start);
  if (fn === null || fn.body.kind !== "block") return null;
  if (parseNoiseInside(diagnostics, fn.span, match.start)) return null;
  const simple = inferFunctionReturn(fn.body, fn.params);
  if (simple === null) return null;
  return {
    start: match.start,
    end: match.start,
    newText: `: ${simple} `,
  };
}

function parseNoiseInside(
  diagnostics: readonly Diagnostic[],
  span: Span,
  at: SourcePosition,
): boolean {
  return diagnostics.some((item) => {
    if (!item.code.startsWith("jsv.parse.") || item.start === undefined) {
      return false;
    }
    if (item.start.line === at.line && item.start.column === at.column) {
      return false;
    }
    return contains(span, item.start.line, item.start.column);
  });
}

function inferFunctionReturn(body: Block, params: Param[]): SimpleType | null {
  const root = new Map<string, SimpleType>();
  for (const param of params) {
    const simple = simpleTypeNode(param.type);
    if (simple !== null) root.set(param.name, simple);
  }
  const valued: SimpleType[] = [];
  let bare = 0;
  let failed = false;
  const walk = (stmt: Statement, env: Map<string, SimpleType>): void => {
    if (failed) return;
    switch (stmt.kind) {
      case "return":
        if (stmt.argument === null) bare += 1;
        else {
          const simple = inferSimpleExpr(stmt.argument, env);
          if (simple === null) failed = true;
          else valued.push(simple);
        }
        return;
      case "var": {
        if (stmt.type !== null) {
          const simple = simpleTypeNode(stmt.type);
          if (simple !== null) env.set(stmt.name, simple);
        }
        return;
      }
      case "block":
        walkBlock(stmt, new Map(env));
        return;
      case "if":
        walk(stmt.consequent, new Map(env));
        if (stmt.alternate !== null) walk(stmt.alternate, new Map(env));
        return;
      case "while":
        walk(stmt.body, new Map(env));
        return;
      case "for":
        {
          const loop = new Map(env);
          if (stmt.init !== null && stmt.init.kind === "var") walk(stmt.init, loop);
          walk(stmt.body, loop);
        }
        return;
      case "function":
      case "class":
      case "import":
      case "empty":
      case "type_alias":
      case "interface":
      case "expr_stmt":
        return;
      default: {
        const _exhaustive: never = stmt;
        return _exhaustive;
      }
    }
  };
  const walkBlock = (block: Block, env: Map<string, SimpleType>): void => {
    for (const stmt of block.body) walk(stmt, env);
  };
  walkBlock(body, root);
  if (failed) return null;
  if (bare > 0 && valued.length > 0) return null;
  if (bare > 0) return "void";
  if (valued.length === 0) return body.body.length === 0 ? "void" : null;
  const first = valued[0];
  if (first === undefined || valued.some((item) => item !== first)) return null;
  return first;
}

function simpleTypeNode(node: TypeNode): SimpleType | null {
  if (node.kind !== "prim") return null;
  if (node.name === "never" || node.name === "unknown") return null;
  return node.name;
}

function inferSimpleExpr(
  expr: Expr,
  env: Map<string, SimpleType>,
): SimpleType | null {
  switch (expr.kind) {
    case "number":
      return "number";
    case "string":
      return "string";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "ident":
      return env.get(expr.name) ?? null;
    case "unary":
      if (expr.op === "-" && inferSimpleExpr(expr.argument, env) === "number") {
        return "number";
      }
      if (expr.op === "!" && inferSimpleExpr(expr.argument, env) === "boolean") {
        return "boolean";
      }
      return null;
    case "binary": {
      if (
        expr.op === "&&" ||
        expr.op === "||" ||
        expr.op === "==" ||
        expr.op === "!=" ||
        expr.op === "===" ||
        expr.op === "!==" ||
        expr.op === "<" ||
        expr.op === ">" ||
        expr.op === "<=" ||
        expr.op === ">="
      ) {
        return "boolean";
      }
      const left = inferSimpleExpr(expr.left, env);
      const right = inferSimpleExpr(expr.right, env);
      if (left === null || right === null) return null;
      if (expr.op === "+") {
        if (left === "number" && right === "number") return "number";
        if (
          (left === "string" || left === "number") &&
          (right === "string" || right === "number") &&
          (left === "string" || right === "string")
        ) {
          return "string";
        }
        return null;
      }
      if (
        (expr.op === "-" || expr.op === "*" || expr.op === "/" || expr.op === "%") &&
        left === "number" &&
        right === "number"
      ) {
        return "number";
      }
      return null;
    }
    case "ternary": {
      const consequent = inferSimpleExpr(expr.consequent, env);
      const alternate = inferSimpleExpr(expr.alternate, env);
      if (consequent === null || consequent !== alternate) return null;
      return consequent;
    }
    case "template":
      for (const part of expr.parts) {
        if (part.kind !== "expr") continue;
        const inner = inferSimpleExpr(part.expr, env);
        if (inner !== "string" && inner !== "number" && inner !== "boolean") {
          return null;
        }
      }
      return "string";
    default:
      return null;
  }
}

function removeTypeArgsEdit(
  source: string,
  expr: Extract<Expr, { kind: "call" | "new" }>,
): TextEdit | null {
  const range = typeArgRange(source, expr);
  if (range === null) return null;
  return { start: range.start, end: range.end, newText: "" };
}

function typeArgSource(
  source: string,
  expr: Extract<Expr, { kind: "call" | "new" }>,
): string | null {
  const range = typeArgRange(source, expr);
  if (range === null) return null;
  const start = indexAt(source, range.start);
  const end = indexAt(source, range.end);
  if (start < 0 || end < start) return null;
  const text = source.slice(start, end);
  if (!text.startsWith("<") || !text.endsWith(">")) return null;
  return text;
}

function typeArgRange(
  source: string,
  expr: Extract<Expr, { kind: "call" | "new" }>,
): { start: SourcePosition; end: SourcePosition } | null {
  const first = expr.typeArgs[0];
  const last = expr.typeArgs[expr.typeArgs.length - 1];
  if (first === undefined || last === undefined) return null;
  const firstIdx = indexAt(source, first.span.start);
  const lastEnd = indexAt(source, after(last.span.end));
  if (firstIdx < 0 || lastEnd < 0) return null;
  let open = firstIdx - 1;
  while (open >= 0 && /\s/.test(source[open] ?? "")) open -= 1;
  if (source[open] !== "<") return null;
  let close = lastEnd;
  while (close < source.length && /\s/.test(source[close] ?? "")) close += 1;
  if (source[close] !== ">") return null;
  return {
    start: positionAt(source, open),
    end: positionAt(source, close + 1),
  };
}

type EffectDerivation = {
  stmt: Extract<Statement, { kind: "expr_stmt" }>;
  target: string;
  value: Expr;
};

function findEffectDerivation(
  program: Program,
  effectNames: ReadonlySet<string>,
  line: number,
  column: number,
): EffectDerivation | null {
  let found: EffectDerivation | null = null;
  walkStmts(program.body, (stmt) => {
    if (found !== null || stmt.kind !== "expr_stmt") return;
    const expr = stmt.expression;
    if (expr.kind !== "call" || expr.callee.kind !== "ident") return;
    if (!effectNames.has(expr.callee.name)) return;
    if (expr.span.start.line !== line || expr.span.start.column !== column) return;
    const cb = expr.args[0];
    if (cb === undefined || cb.kind !== "arrow") return;
    const set = singleSet(cb.body);
    if (set === null) return;
    found = { stmt, target: set.target, value: set.value };
  });
  return found;
}

function singleSet(body: Expr | Block): { target: string; value: Expr } | null {
  let expr: Expr;
  if (body.kind === "block") {
    if (body.body.length !== 1) return null;
    const stmt = body.body[0];
    if (stmt === undefined || stmt.kind !== "expr_stmt") return null;
    expr = stmt.expression;
  } else {
    expr = body;
  }
  if (expr.kind !== "call" || expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg === undefined) return null;
  if (expr.callee.kind !== "member" || expr.callee.property !== "set") return null;
  if (expr.callee.object.kind !== "ident") return null;
  return { target: expr.callee.object.name, value: arg };
}

function valueIsReads(expr: Expr): boolean {
  let reads = 0;
  let bad = false;
  const walk = (node: Expr): void => {
    if (node.kind === "call") {
      const get =
        node.callee.kind === "member" &&
        node.callee.property === "get" &&
        node.callee.object.kind === "ident" &&
        node.args.length === 0;
      if (!get) bad = true;
      else reads += 1;
    }
    walkExprChildren(node, walk);
  };
  walk(expr);
  return !bad && reads > 0;
}

function identUsed(expr: Expr, name: string): boolean {
  if (expr.kind === "ident") return expr.name === name;
  let used = false;
  walkExprChildren(expr, (child) => {
    if (identUsed(child, name)) used = true;
  });
  return used;
}

function writeCount(program: Program, name: string): number {
  let count = 0;
  walkProgram(program, (expr) => {
    if (
      expr.kind === "call" &&
      expr.callee.kind === "member" &&
      expr.callee.object.kind === "ident" &&
      expr.callee.object.name === name &&
      (expr.callee.property === "set" || expr.callee.property === "update")
    ) {
      count += 1;
    }
  });
  return count;
}

function findSignalDecl(
  program: Program,
  name: string,
  signalNames: ReadonlySet<string>,
): VarStmt | null {
  const found: VarStmt[] = [];
  walkStmts(program.body, (stmt) => {
    if (stmt.kind !== "var" || stmt.name !== name || stmt.init === null) return;
    const init = stmt.init;
    if (
      init.kind === "call" &&
      init.callee.kind === "ident" &&
      signalNames.has(init.callee.name) &&
      init.typeArgs.length > 0
    ) {
      found.push(stmt);
    }
  });
  if (found.length !== 1) return null;
  return found[0] ?? null;
}

function domLocals(program: Program): {
  signal: Set<string>;
  computed: Set<string>;
  effect: Set<string>;
} {
  const locals = {
    signal: new Set<string>(),
    computed: new Set<string>(),
    effect: new Set<string>(),
  };
  for (const stmt of program.body) {
    if (stmt.kind !== "import" || stmt.moduleSpecifier !== "jsv/dom") continue;
    for (const spec of stmt.names) {
      if (spec.imported === "signal") locals.signal.add(spec.local);
      else if (spec.imported === "computed") locals.computed.add(spec.local);
      else if (spec.imported === "effect") locals.effect.add(spec.local);
    }
  }
  return locals;
}

function deleteThroughNewline(source: string, span: Span): TextEdit {
  let endIndex = indexAt(source, after(span.end));
  if (endIndex >= 0 && source.charCodeAt(endIndex) === 10) endIndex += 1;
  const end = endIndex < 0 ? after(span.end) : positionAt(source, endIndex);
  return { start: span.start, end, newText: "" };
}

function editsOverlap(source: string, edits: readonly TextEdit[]): boolean {
  const spans = edits.map((edit) => ({
    start: indexAt(source, edit.start),
    end: indexAt(source, edit.end),
  }));
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i];
      const b = spans[j];
      if (a === undefined || b === undefined) continue;
      if (a.start < 0 || b.start < 0) return true;
      if (a.start < b.end && b.start < a.end) return true;
    }
  }
  return false;
}

function findExpr(
  program: Program,
  start: SourcePosition,
  end: SourcePosition,
): { expr: Expr; annotatedInit: boolean } | null {
  let found: { expr: Expr; annotatedInit: boolean } | null = null;
  walkProgram(program, (expr, annotatedInit) => {
    if (found !== null) return;
    if (spanEq(expr.span, start, end)) found = { expr, annotatedInit };
  });
  return found;
}

function findAssign(
  program: Program,
  start: SourcePosition,
  end: SourcePosition,
): Extract<Expr, { kind: "assign" }> | null {
  let found: Extract<Expr, { kind: "assign" }> | null = null;
  walkProgram(program, (expr) => {
    if (found !== null || expr.kind !== "assign") return;
    if (spanEq(expr.target.span, start, end)) found = expr;
  });
  return found;
}

function findOnlyConst(
  program: Program,
  name: string,
  at: SourcePosition,
): VarStmt | null {
  const decls: VarStmt[] = [];
  walkStmts(program.body, (stmt) => {
    if (stmt.kind === "var" && stmt.declKind === "const" && stmt.name === name) {
      decls.push(stmt);
    }
  });
  if (decls.length !== 1) return null;
  const decl = decls[0];
  if (decl === undefined) return null;
  if (contains(decl.span, at.line, at.column)) return null;
  const afterDecl =
    at.line > decl.nameSpan.end.line ||
    (at.line === decl.nameSpan.end.line && at.column > decl.nameSpan.end.column);
  return afterDecl ? decl : null;
}

function findMissingReturnExpr(
  program: Program,
  start: SourcePosition,
  end: SourcePosition,
): Expr | null {
  let found: Expr | null = null;
  eachFn(program, (fn) => {
    if (found !== null || fn.body.kind !== "block") return;
    const nameHit =
      fn.nameSpan !== null &&
      fn.nameSpan.start.line === start.line &&
      fn.nameSpan.start.column === start.column;
    const arrowHit = fn.nameSpan === null && spanEq(fn.span, start, end);
    if (!nameHit && !arrowHit) return;
    found = soleExpr(fn.body);
  });
  return found;
}

function findReturnTypeTarget(program: Program, start: SourcePosition): FnLike | null {
  let found: FnLike | null = null;
  eachFn(program, (fn) => {
    if (found !== null || fn.returnType === null) return;
    if (fn.returnType.kind !== "prim" || fn.returnType.name !== "unknown") return;
    if (
      fn.returnType.span.start.line === start.line &&
      fn.returnType.span.start.column === start.column
    ) {
      found = fn;
    }
  });
  return found;
}

function soleExpr(body: Block): Expr | null {
  if (body.body.length !== 1) return null;
  const stmt = body.body[0];
  if (stmt === undefined || stmt.kind !== "expr_stmt") return null;
  return stmt.expression;
}

function spanEq(span: Span, start: SourcePosition, end: SourcePosition): boolean {
  return (
    span.start.line === start.line &&
    span.start.column === start.column &&
    span.end.line === end.line &&
    span.end.column === end.column
  );
}

function eachFn(program: Program, visit: (fn: FnLike) => void): void {
  const walkStmt = (stmt: Statement): void => {
    switch (stmt.kind) {
      case "function":
        visit({
          span: stmt.span,
          nameSpan: stmt.nameSpan,
          params: stmt.params,
          returnType: stmt.returnType,
          body: stmt.body,
        });
        walkBlock(stmt.body);
        return;
      case "class":
        for (const member of stmt.members) {
          if (member.kind === "method") {
            visit({
              span: member.span,
              nameSpan: member.nameSpan,
              params: member.params,
              returnType: member.returnType,
              body: member.body,
            });
            walkBlock(member.body);
          } else if (member.kind === "constructor") {
            walkBlock(member.body);
          }
        }
        return;
      case "block":
        walkBlock(stmt);
        return;
      case "if":
        walkStmt(stmt.consequent);
        if (stmt.alternate !== null) walkStmt(stmt.alternate);
        return;
      case "while":
        walkStmt(stmt.body);
        return;
      case "for":
        if (stmt.init !== null && stmt.init.kind === "var") walkStmt(stmt.init);
        walkStmt(stmt.body);
        return;
      case "var":
        if (stmt.init !== null) walkExpr(stmt.init);
        return;
      case "return":
        if (stmt.argument !== null) walkExpr(stmt.argument);
        return;
      case "expr_stmt":
        walkExpr(stmt.expression);
        return;
      case "import":
      case "empty":
      case "type_alias":
      case "interface":
        return;
      default: {
        const _exhaustive: never = stmt;
        return _exhaustive;
      }
    }
  };
  const walkBlock = (block: Block): void => {
    for (const stmt of block.body) walkStmt(stmt);
  };
  const walkExpr = (expr: Expr): void => {
    if (expr.kind === "arrow") {
      visit({
        span: expr.span,
        nameSpan: null,
        params: expr.params,
        returnType: null,
        body: expr.body,
      });
    }
    walkExprChildren(expr, walkExpr);
    if (expr.kind === "arrow" && expr.body.kind === "block") walkBlock(expr.body);
  };
  for (const stmt of program.body) walkStmt(stmt);
}

function walkProgram(
  program: Program,
  visit: (expr: Expr, annotatedInit: boolean) => void,
): void {
  const walkExpr = (expr: Expr, annotatedInit: boolean): void => {
    visit(expr, annotatedInit);
    if (expr.kind === "arrow" && expr.body.kind === "block") {
      walkBlock(expr.body);
      return;
    }
    walkExprChildren(expr, (child) => walkExpr(child, false));
  };
  const walkStmt = (stmt: Statement): void => {
    switch (stmt.kind) {
      case "var":
        if (stmt.init !== null) walkExpr(stmt.init, stmt.type !== null);
        return;
      case "function":
        walkBlock(stmt.body);
        return;
      case "class":
        for (const member of stmt.members) {
          if (member.kind === "constructor" || member.kind === "method") {
            walkBlock(member.body);
          }
        }
        return;
      case "if":
        walkExpr(stmt.test, false);
        walkStmt(stmt.consequent);
        if (stmt.alternate !== null) walkStmt(stmt.alternate);
        return;
      case "while":
        walkExpr(stmt.test, false);
        walkStmt(stmt.body);
        return;
      case "for":
        if (stmt.init !== null) {
          if (stmt.init.kind === "var") walkStmt(stmt.init);
          else walkExpr(stmt.init, false);
        }
        if (stmt.test !== null) walkExpr(stmt.test, false);
        if (stmt.update !== null) walkExpr(stmt.update, false);
        walkStmt(stmt.body);
        return;
      case "return":
        if (stmt.argument !== null) walkExpr(stmt.argument, false);
        return;
      case "block":
        walkBlock(stmt);
        return;
      case "expr_stmt":
        walkExpr(stmt.expression, false);
        return;
      case "import":
      case "empty":
      case "type_alias":
      case "interface":
        return;
      default: {
        const _exhaustive: never = stmt;
        return _exhaustive;
      }
    }
  };
  const walkBlock = (block: Block): void => {
    for (const stmt of block.body) walkStmt(stmt);
  };
  walkBlock({ kind: "block", body: program.body, span: program.span });
}

function walkStmts(body: Statement[], visit: (stmt: Statement) => void): void {
  const walk = (stmt: Statement): void => {
    visit(stmt);
    switch (stmt.kind) {
      case "function":
        for (const inner of stmt.body.body) walk(inner);
        return;
      case "class":
        for (const member of stmt.members) {
          if (member.kind === "constructor" || member.kind === "method") {
            for (const inner of member.body.body) walk(inner);
          }
        }
        return;
      case "block":
        for (const inner of stmt.body) walk(inner);
        return;
      case "if":
        walk(stmt.consequent);
        if (stmt.alternate !== null) walk(stmt.alternate);
        return;
      case "while":
        walk(stmt.body);
        return;
      case "for":
        if (stmt.init !== null && stmt.init.kind === "var") walk(stmt.init);
        walk(stmt.body);
        return;
      case "var":
      case "return":
      case "expr_stmt":
      case "import":
      case "empty":
      case "type_alias":
      case "interface":
        return;
      default: {
        const _exhaustive: never = stmt;
        return _exhaustive;
      }
    }
  };
  for (const stmt of body) walk(stmt);
}

function walkExprChildren(expr: Expr, walk: (expr: Expr) => void): void {
  switch (expr.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "undefined":
    case "ident":
      return;
    case "template":
      for (const part of expr.parts) {
        if (part.kind === "expr") walk(part.expr);
      }
      return;
    case "array":
      for (const el of expr.elements) walk(el);
      return;
    case "object":
      for (const prop of expr.properties) walk(prop.value);
      return;
    case "unary":
      walk(expr.argument);
      return;
    case "binary":
      walk(expr.left);
      walk(expr.right);
      return;
    case "assign":
      walk(expr.target);
      walk(expr.value);
      return;
    case "ternary":
      walk(expr.test);
      walk(expr.consequent);
      walk(expr.alternate);
      return;
    case "call":
    case "new":
      walk(expr.callee);
      for (const arg of expr.args) walk(arg);
      return;
    case "member":
      walk(expr.object);
      return;
    case "index":
      walk(expr.object);
      walk(expr.index);
      return;
    case "arrow":
      if (expr.body.kind === "block") return;
      walk(expr.body);
      return;
    case "assert":
      walk(expr.expression);
      return;
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}
