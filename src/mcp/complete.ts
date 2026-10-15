import {
  checkSource,
  type CapturedBinding,
  type CheckOptions,
  type CompletionCapture,
} from "../checker/check.ts";
import { createDomLibModule } from "../checker/dom-lib.ts";
import type { Diagnostic, SourcePosition } from "../diagnostics.ts";
import type { ImportStmt, Program, Span } from "../parser/ast.ts";
import { parse } from "../parser/parse.ts";
import {
  typeToString,
  unwrap,
  type Type,
} from "../checker/types.ts";

export type CompletionCandidate = {
  name: string;
  kind:
    | "local"
    | "param"
    | "import"
    | "declaration"
    | "ambient"
    | "member"
    | "module-export";
  bindingKind: "value" | "type" | "both";
  /** Checker type string. For type-only bindings, the declared type name. */
  type: string;
  /** Set for member completions. `type` is the declared property type. */
  optional?: boolean;
};

export type CompletionResult = {
  /** Identifier text from the token start through the cursor character. */
  prefix: string;
  /** Half-open range `[start, end)` replaced by a chosen name. */
  replace: { start: SourcePosition; end: SourcePosition };
  candidates: CompletionCandidate[];
  diagnostics: Diagnostic[];
};

export function completionsAt(
  source: string,
  file: string,
  line: number,
  column: number,
  options?: CheckOptions,
): CompletionResult {
  const completion: CompletionCapture = {
    line,
    column,
    source,
    scopeBest: null,
    memberBest: null,
  };
  const { diagnostics } = checkSource(source, file, {
    ...options,
    typecheckPartial: true,
    completion,
  });
  const { program } = parse(source, file);
  const atCursor = identifierAt(source, line, column);

  const importContext = jsvDomImportContext(source, program, line, column);
  if (importContext) {
    return finish(
      domExportCandidates(),
      atCursor.prefix,
      atCursor.replace,
      diagnostics,
    );
  }
  if (insideImport(program, line, column)) {
    return finish([], "", atCursor.replace, diagnostics);
  }

  const member = completion.memberBest;
  if (member !== null) {
    const replace = memberReplace(source, member.propertySpan, line, column, atCursor);
    return finish(
      memberCandidates(member.objectType),
      replace.prefix,
      replace.replace,
      diagnostics,
    );
  }

  return finish(
    (completion.scopeBest?.bindings ?? []).map(bindingCandidate),
    atCursor.prefix,
    atCursor.replace,
    diagnostics,
  );
}

function finish(
  candidates: CompletionCandidate[],
  prefix: string,
  replace: { start: SourcePosition; end: SourcePosition },
  diagnostics: Diagnostic[],
): CompletionResult {
  const filtered = candidates.filter(
    (candidate) => prefix === "" || candidate.name.startsWith(prefix),
  );
  filtered.sort(
    (a, b) => a.name.localeCompare(b.name) || a.kind.localeCompare(b.kind),
  );
  return { prefix, replace, candidates: filtered, diagnostics };
}

function bindingCandidate(binding: CapturedBinding): CompletionCandidate {
  return {
    name: binding.name,
    kind: binding.origin,
    bindingKind: binding.kind,
    type: binding.type,
  };
}

function domExportCandidates(): CompletionCandidate[] {
  const mod = createDomLibModule();
  const candidates: CompletionCandidate[] = [];
  for (const [name, binding] of mod.namedValues) {
    candidates.push({
      name,
      kind: "module-export",
      bindingKind: binding.kind === "type" ? "type" : binding.kind,
      type: typeToString(binding.valueType),
    });
  }
  for (const [name, binding] of mod.namedTypes) {
    if (mod.namedValues.has(name)) continue;
    const def = binding.typeDef;
    const type =
      def === undefined
        ? name
        : def.typeParams.length === 0
          ? def.name
          : `${def.name}<${def.typeParams.join(", ")}>`;
    candidates.push({
      name,
      kind: "module-export",
      bindingKind: "type",
      type,
    });
  }
  return candidates;
}

type PropInfo = { name: string; optional: boolean; type: Type };

function propertiesOf(type: Type): PropInfo[] {
  const current = unwrap(type);
  if (current.kind === "object") {
    return current.props.map((prop) => ({
      name: prop.name,
      optional: prop.optional,
      type: prop.type,
    }));
  }
  if (current.kind === "union") {
    const lists = current.members.map((member) => propertiesOf(member));
    const first = lists[0];
    if (first === undefined) return [];
    return first.filter((prop) =>
      lists.every((list) =>
        list.some(
          (other) =>
            other.name === prop.name &&
            other.optional === prop.optional &&
            typeToString(other.type) === typeToString(prop.type),
        ),
      ),
    );
  }
  return [];
}

function memberCandidates(objectType: Type): CompletionCandidate[] {
  return propertiesOf(objectType).map((prop) => ({
    name: prop.name,
    kind: "member" as const,
    bindingKind: "value" as const,
    type: typeToString(prop.type),
    optional: prop.optional,
  }));
}

function memberReplace(
  source: string,
  propertySpan: Span,
  line: number,
  column: number,
  atCursor: { prefix: string; replace: { start: SourcePosition; end: SourcePosition } },
): { prefix: string; replace: { start: SourcePosition; end: SourcePosition } } {
  if (contains(propertySpan, line, column)) return atCursor;
  const text = sourceSlice(source, propertySpan.start, propertySpan.end);
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return {
      prefix: "",
      replace: {
        start: propertySpan.start,
        end: after(propertySpan.end),
      },
    };
  }
  const insert = after({ line, column });
  return { prefix: "", replace: { start: insert, end: insert } };
}

function insideImport(program: Program, line: number, column: number): boolean {
  return program.body.some(
    (stmt) => stmt.kind === "import" && contains(stmt.span, line, column),
  );
}

function jsvDomImportContext(
  source: string,
  program: Program,
  line: number,
  column: number,
): boolean {
  const cursor = indexAt(source, { line, column });
  if (cursor < 0) return false;
  for (const stmt of program.body) {
    if (stmt.kind !== "import" || stmt.moduleSpecifier !== "jsv/dom") continue;
    if (!contains(stmt.span, line, column)) continue;
    const region = braceRegion(source, stmt);
    if (region === null) continue;
    if (cursor <= region.open || cursor >= region.close) continue;
    if (onLocalAlias(source, stmt, cursor, line, column)) return false;
    return true;
  }
  return false;
}

function braceRegion(
  source: string,
  stmt: ImportStmt,
): { open: number; close: number } | null {
  const start = indexAt(source, stmt.span.start);
  const end = indexAt(source, stmt.span.end);
  if (start < 0 || end < start) return null;
  const text = source.slice(start, end + 1);
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close < open) return null;
  return { open: start + open, close: start + close };
}

function onLocalAlias(
  source: string,
  stmt: ImportStmt,
  cursor: number,
  line: number,
  column: number,
): boolean {
  for (const name of stmt.names) {
    if (name.imported === name.local) continue;
    if (!contains(name.span, line, column)) continue;
    const nameStart = indexAt(source, name.span.start);
    const text = sourceSlice(source, name.span.start, name.span.end);
    const asAt = text.indexOf(" as ");
    if (asAt >= 0 && cursor >= nameStart + asAt + 4) return true;
  }
  return false;
}

function identifierAt(
  source: string,
  line: number,
  column: number,
): { prefix: string; replace: { start: SourcePosition; end: SourcePosition } } {
  const here = { line, column };
  const empty = { prefix: "", replace: { start: here, end: here } };
  const index = indexAt(source, here);
  if (index < 0 || index >= source.length) return empty;
  const ch = source[index] ?? "";
  if (!isIdentPart(ch)) return empty;
  let start = index;
  while (start > 0 && isIdentPart(source[start - 1] ?? "")) start -= 1;
  if (!isIdentStart(source[start] ?? "")) return empty;
  let end = index;
  while (end + 1 < source.length && isIdentPart(source[end + 1] ?? "")) end += 1;
  return {
    prefix: source.slice(start, index + 1),
    replace: {
      start: positionAt(source, start),
      end: positionAt(source, end + 1),
    },
  };
}

function isIdentStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function after(pos: SourcePosition): SourcePosition {
  return { line: pos.line, column: pos.column + 1 };
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
