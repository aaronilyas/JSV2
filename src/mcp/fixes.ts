import {
  checkSource,
  type CapturedBinding,
  type CheckOptions,
  type CompletionCapture,
} from "../checker/check.ts";
import { createDomLibModule } from "../checker/dom-lib.ts";
import type { Diagnostic, SourcePosition } from "../diagnostics.ts";
import type {
  Expr,
  ImportStmt,
  Program,
  Span,
  Statement,
  TypeNode,
} from "../parser/ast.ts";
import { parse } from "../parser/parse.ts";

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
    completion,
  });
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
    const typo = uniqueTypo(name, use.kind, bindings);
    if (importEdit !== null && typo !== null) {
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
    if (typo !== null) {
      return {
        applicable: true,
        edits: [
          {
            start: match.start,
            end: after(match.end),
            newText: typo,
          },
        ],
        message: `Replace '${name}' with '${typo}'.`,
        diagnostics,
      };
    }
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
      case "await":
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

function uniqueTypo(
  name: string,
  use: "value" | "type",
  bindings: readonly CapturedBinding[],
): string | null {
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
  for (const candidate of names) {
    if (editDistance(name, candidate) !== 1) continue;
    if (chosen !== null) return null;
    chosen = candidate;
  }
  return chosen;
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
