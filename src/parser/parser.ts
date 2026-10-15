import type { Diagnostic, SourcePosition } from "../diagnostics.ts";
import type {
  Block,
  ClassDecl,
  ClassMember,
  Expr,
  ForStmt,
  FunctionDecl,
  IfStmt,
  ImportStmt,
  InterfaceDecl,
  JsxAttribute,
  JsxChild,
  Param,
  Program,
  ReturnStmt,
  Span,
  Statement,
  TypeAlias,
  TypeMember,
  TypeNode,
  VarStmt,
  WhileStmt,
  PrimName,
  BinaryOp,
} from "./ast.ts";
import {
  type LexerState,
  type Token,
  type TokenKind,
  pullToken,
  scanJsxText,
} from "./lexer.ts";

const PRIM_NAMES = new Set<string>([
  "string",
  "number",
  "boolean",
  "null",
  "void",
  "never",
  "unknown",
  "undefined",
]);

type Parser = {
  lexer: LexerState;
  index: number;
  file: string;
  diagnostics: Diagnostic[];
};

function ensure(p: Parser, index: number): void {
  while (p.lexer.tokens.length <= index && !p.lexer.finished) {
    pullToken(p.lexer);
  }
}

function current(p: Parser): Token {
  ensure(p, p.index);
  return p.lexer.tokens[p.index] ?? p.lexer.tokens[p.lexer.tokens.length - 1]!;
}

function peek(p: Parser, offset = 0): Token {
  ensure(p, p.index + offset);
  return (
    p.lexer.tokens[p.index + offset] ??
    p.lexer.tokens[p.lexer.tokens.length - 1]!
  );
}

function at(p: Parser, kind: TokenKind, text?: string): boolean {
  const t = current(p);
  if (t.kind !== kind) return false;
  if (text !== undefined && t.text !== text) return false;
  return true;
}

function atKeyword(p: Parser, kw: string): boolean {
  return at(p, "keyword", kw);
}

function advance(p: Parser): Token {
  const t = current(p);
  if (t.kind !== "eof") {
    p.index += 1;
  }
  return t;
}

function previous(p: Parser): Token {
  return p.lexer.tokens[p.index - 1] ?? current(p);
}

function spanOf(start: Token, end: Token): Span {
  return { start: start.span.start, end: end.span.end };
}

function mergeSpan(a: Span, b: Span): Span {
  return { start: a.start, end: b.end };
}

function tokenSpan(t: Token): Span {
  return { start: t.span.start, end: t.span.end };
}

function diag(
  p: Parser,
  code: string,
  message: string,
  span: Span,
  hint?: string,
): void {
  const d: Diagnostic = {
    code,
    severity: "error",
    message,
    file: p.file,
    start: span.start,
    end: span.end,
  };
  if (hint !== undefined) {
    d.hint = hint;
  }
  p.diagnostics.push(d);
}

function unexpected(p: Parser, expected: string): void {
  const t = current(p);
  if (t.kind === "eof") {
    diag(
      p,
      "jsv.parse.unexpected_eof",
      `unexpected end of file, expected ${expected}`,
      tokenSpan(t),
    );
  } else {
    diag(
      p,
      "jsv.parse.unexpected_token",
      `unexpected token \`${t.text}\`, expected ${expected}`,
      tokenSpan(t),
    );
  }
}

function expect(p: Parser, kind: TokenKind, expected: string): Token {
  if (at(p, kind)) {
    return advance(p);
  }
  unexpected(p, expected);
  return current(p);
}

function expectKeyword(p: Parser, kw: string): Token {
  if (atKeyword(p, kw)) {
    return advance(p);
  }
  unexpected(p, `\`${kw}\``);
  return current(p);
}

function expectIdent(p: Parser): Token {
  if (at(p, "ident")) {
    return advance(p);
  }
  unexpected(p, "identifier");
  return current(p);
}

function recoverStatement(p: Parser): void {
  while (!at(p, "eof")) {
    if (at(p, ";")) {
      advance(p);
      return;
    }
    if (at(p, "}")) {
      return;
    }
    advance(p);
  }
}

/** Skip to `;` (consumed) or `}` / EOF (not consumed). Always makes progress if possible. */
function recoverMember(p: Parser): void {
  while (!at(p, "eof")) {
    if (at(p, ";")) {
      advance(p);
      return;
    }
    if (at(p, "}")) {
      return;
    }
    advance(p);
  }
}

/** If `before` index was not advanced, recover then force-consume one token. */
function ensureProgress(p: Parser, before: number): void {
  if (p.index !== before) return;
  recoverMember(p);
  if (p.index === before && !at(p, "eof")) {
    advance(p);
  }
}

// ---------- Types ----------

function parseType(p: Parser): TypeNode {
  const first = parseUnionPrimary(p);
  if (!at(p, "|")) {
    return first;
  }
  const types: TypeNode[] = [first];
  while (at(p, "|")) {
    advance(p);
    types.push(parseUnionPrimary(p));
  }
  const last = types[types.length - 1]!;
  return {
    kind: "union",
    types,
    span: mergeSpan(first.span, last.span),
  };
}

function parseUnionPrimary(p: Parser): TypeNode {
  let t = parseTypeAtom(p);
  while (at(p, "[") && peek(p, 1).kind === "]") {
    const start = t.span.start;
    advance(p); // [
    const endTok = advance(p); // ]
    t = {
      kind: "array",
      element: t,
      span: { start, end: endTok.span.end },
    };
  }
  return t;
}

function parseTypeAtom(p: Parser): TypeNode {
  if (
    at(p, "keyword") &&
    PRIM_NAMES.has(current(p).text)
  ) {
    const tok = advance(p);
    return {
      kind: "prim",
      name: tok.text as PrimName,
      span: tokenSpan(tok),
    };
  }

  if (at(p, "ident")) {
    const nameTok = advance(p);
    let args: TypeNode[] = [];
    let end = nameTok.span.end;
    if (at(p, "<")) {
      const ta = parseTypeArgs(p);
      args = ta.args;
      end = ta.end;
    }
    return {
      kind: "named",
      name: nameTok.text,
      nameSpan: tokenSpan(nameTok),
      args,
      span: { start: nameTok.span.start, end },
    };
  }

  if (at(p, "{")) {
    return parseObjectType(p);
  }

  if (at(p, "(")) {
    // Could be parenthesized type or function type (params) => Type
    return parseParenOrFunctionType(p);
  }

  unexpected(p, "type");
  const t = current(p);
  // Produce a placeholder prim so callers always get a TypeNode.
  return { kind: "prim", name: "unknown", span: tokenSpan(t) };
}

function parseTypeArgs(p: Parser): { args: TypeNode[]; end: SourcePosition } {
  expect(p, "<", "`<`");
  const args: TypeNode[] = [];
  if (!at(p, ">")) {
    for (;;) {
      args.push(parseType(p));
      if (at(p, ",")) {
        advance(p);
        if (at(p, ">")) break;
        continue;
      }
      break;
    }
  }
  const endTok = expect(p, ">", "`>`");
  return { args, end: endTok.span.end };
}

function parseTypeParams(
  p: Parser,
): { name: string; span: Span }[] {
  if (!at(p, "<")) return [];
  advance(p);
  const params: { name: string; span: Span }[] = [];
  if (!at(p, ">")) {
    for (;;) {
      const id = expectIdent(p);
      params.push({ name: id.text, span: tokenSpan(id) });
      if (at(p, ",")) {
        advance(p);
        if (at(p, ">")) break;
        continue;
      }
      break;
    }
  }
  expect(p, ">", "`>`");
  return params;
}

function parseObjectType(p: Parser): TypeNode {
  const startTok = expect(p, "{", "`{`");
  const members: TypeMember[] = [];
  while (!at(p, "}") && !at(p, "eof")) {
    const before = p.index;
    members.push(parseTypeMember(p));
    ensureProgress(p, before);
  }
  const endTok = expect(p, "}", "`}`");
  return {
    kind: "object",
    members,
    span: spanOf(startTok, endTok),
  };
}

function parseTypeMember(p: Parser): TypeMember {
  if (!at(p, "ident")) {
    const tok = current(p);
    unexpected(p, "identifier");
    recoverMember(p);
    return {
      kind: "prop",
      name: "_",
      nameSpan: tokenSpan(tok),
      optional: false,
      type: { kind: "prim", name: "unknown", span: tokenSpan(tok) },
      span: tokenSpan(tok),
    };
  }
  const nameTok = advance(p);
  const typeParams = at(p, "<") ? parseTypeParams(p) : [];

  if (at(p, "(") || typeParams.length > 0) {
    // Method signature. If we saw type params, `(` is required.
    const params = parseParamList(p);
    expect(p, ":", "`:`");
    const returnType = parseType(p);
    const semi = expect(p, ";", "`;`");
    return {
      kind: "method_sig",
      name: nameTok.text,
      nameSpan: tokenSpan(nameTok),
      typeParams,
      params,
      returnType,
      span: { start: nameTok.span.start, end: semi.span.end },
    };
  }

  let optional = false;
  if (at(p, "?")) {
    advance(p);
    optional = true;
  }
  expect(p, ":", "`:`");
  const type = parseType(p);
  const semi = expect(p, ";", "`;`");
  return {
    kind: "prop",
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    optional,
    type,
    span: { start: nameTok.span.start, end: semi.span.end },
  };
}

function parseParamList(p: Parser): Param[] {
  expect(p, "(", "`(`");
  const params: Param[] = [];
  if (!at(p, ")")) {
    for (;;) {
      params.push(parseParam(p));
      if (at(p, ",")) {
        advance(p);
        if (at(p, ")")) break;
        continue;
      }
      break;
    }
  }
  expect(p, ")", "`)`");
  return params;
}

function parseParam(p: Parser): Param {
  const nameTok = expectIdent(p);
  expect(p, ":", "`:`");
  const type = parseType(p);
  return {
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    type,
    span: { start: nameTok.span.start, end: type.span.end },
  };
}

function parseParenOrFunctionType(p: Parser): TypeNode {
  // Speculative: try function type if we see ( params ) =>
  // Use checkpoint.
  const checkpoint = p.index;
  const diagCount = p.diagnostics.length;
  const startTok = advance(p); // (

  // Empty params => function type
  if (at(p, ")")) {
    advance(p);
    if (at(p, "=>")) {
      advance(p);
      const returnType = parseType(p);
      return {
        kind: "function",
        params: [],
        returnType,
        span: { start: startTok.span.start, end: returnType.span.end },
      };
    }
    // `()` alone is not a valid type — restore and fail
    p.index = checkpoint;
    p.diagnostics.length = diagCount;
    unexpected(p, "type");
    return { kind: "prim", name: "unknown", span: tokenSpan(current(p)) };
  }

  // Look: ident :  → function params; otherwise parenthesized type
  if (at(p, "ident") && peek(p, 1).kind === ":") {
    // Function type params — re-parse from after (
    const params: Param[] = [];
    for (;;) {
      params.push(parseParam(p));
      if (at(p, ",")) {
        advance(p);
        if (at(p, ")")) break;
        continue;
      }
      break;
    }
    expect(p, ")", "`)`");
    if (!at(p, "=>")) {
      // Not a function type after all — weird. Diagnose.
      unexpected(p, "`=>`");
      return {
        kind: "function",
        params,
        returnType: { kind: "prim", name: "unknown", span: tokenSpan(current(p)) },
        span: { start: startTok.span.start, end: current(p).span.end },
      };
    }
    advance(p); // =>
    const returnType = parseType(p);
    return {
      kind: "function",
      params,
      returnType,
      span: { start: startTok.span.start, end: returnType.span.end },
    };
  }

  // Parenthesized type: ( Type )
  const inner = parseType(p);
  const endTok = expect(p, ")", "`)`");
  // Parentheses are not a node; expand span to cover them.
  return { ...inner, span: { start: startTok.span.start, end: endTok.span.end } };
}

// ---------- Expressions ----------

function parseExpr(p: Parser): Expr {
  return parseAssign(p);
}

function parseAssign(p: Parser): Expr {
  const left = parseTernary(p);
  if (at(p, "=")) {
    advance(p);
    const value = parseAssign(p);
    if (
      left.kind !== "ident" &&
      left.kind !== "member" &&
      left.kind !== "index"
    ) {
      diag(
        p,
        "jsv.parse.invalid_assignment_target",
        "invalid assignment target",
        left.span,
      );
    }
    return {
      kind: "assign",
      target: left,
      value,
      span: mergeSpan(left.span, value.span),
    };
  }
  return left;
}

function parseTernary(p: Parser): Expr {
  const test = parseLogicOr(p);
  if (!at(p, "?")) return test;
  advance(p);
  const consequent = parseExpr(p);
  expect(p, ":", "`:`");
  const alternate = parseTernary(p);
  return {
    kind: "ternary",
    test,
    consequent,
    alternate,
    span: mergeSpan(test.span, alternate.span),
  };
}

function parseLogicOr(p: Parser): Expr {
  let left = parseLogicAnd(p);
  while (at(p, "||")) {
    const op = advance(p).text as BinaryOp;
    const right = parseLogicAnd(p);
    left = {
      kind: "binary",
      op,
      left,
      right,
      span: mergeSpan(left.span, right.span),
    };
  }
  return left;
}

function parseLogicAnd(p: Parser): Expr {
  let left = parseEquality(p);
  while (at(p, "&&")) {
    const op = advance(p).text as BinaryOp;
    const right = parseEquality(p);
    left = {
      kind: "binary",
      op,
      left,
      right,
      span: mergeSpan(left.span, right.span),
    };
  }
  return left;
}

function parseEquality(p: Parser): Expr {
  let left = parseRelational(p);
  while (
    at(p, "==") ||
    at(p, "!=") ||
    at(p, "===") ||
    at(p, "!==")
  ) {
    const op = advance(p).text as BinaryOp;
    const right = parseRelational(p);
    left = {
      kind: "binary",
      op,
      left,
      right,
      span: mergeSpan(left.span, right.span),
    };
  }
  return left;
}

function parseRelational(p: Parser): Expr {
  let left = parseAdditive(p);
  while (
    at(p, "<") ||
    at(p, ">") ||
    at(p, "<=") ||
    at(p, ">=")
  ) {
    // `|` and `&` are handled elsewhere; here also catch unsupported if we see them mid-expr via additive.
    const op = advance(p).text as BinaryOp;
    const right = parseAdditive(p);
    left = {
      kind: "binary",
      op,
      left,
      right,
      span: mergeSpan(left.span, right.span),
    };
  }
  return left;
}

function parseAdditive(p: Parser): Expr {
  let left = parseMultiplicative(p);
  while (at(p, "+") || at(p, "-")) {
    const op = advance(p).text as BinaryOp;
    const right = parseMultiplicative(p);
    left = {
      kind: "binary",
      op,
      left,
      right,
      span: mergeSpan(left.span, right.span),
    };
  }
  // Unsupported bitwise operators in expression position.
  while (at(p, "|") || at(p, "&")) {
    const tok = advance(p);
    diag(
      p,
      "jsv.parse.unsupported_operator",
      `unsupported operator \`${tok.text}\` in expression`,
      tokenSpan(tok),
      "`||` and `&&` are the logical operators; `|` is only valid inside types",
    );
    const right = parseMultiplicative(p);
    left = {
      kind: "binary",
      op: "+",
      left,
      right,
      span: mergeSpan(left.span, right.span),
    };
  }
  return left;
}

function parseMultiplicative(p: Parser): Expr {
  let left = parseUnary(p);
  while (at(p, "*") || at(p, "/") || at(p, "%")) {
    const op = advance(p).text as BinaryOp;
    const right = parseUnary(p);
    left = {
      kind: "binary",
      op,
      left,
      right,
      span: mergeSpan(left.span, right.span),
    };
  }
  return left;
}

function parseUnary(p: Parser): Expr {
  if (at(p, "!") || at(p, "-")) {
    const opTok = advance(p);
    const argument = parseUnary(p);
    return {
      kind: "unary",
      op: opTok.text as "!" | "-",
      argument,
      span: { start: opTok.span.start, end: argument.span.end },
    };
  }
  if (atKeyword(p, "typeof")) {
    const opTok = advance(p);
    const argument = parseUnary(p);
    return {
      kind: "unary",
      op: "typeof",
      argument,
      span: { start: opTok.span.start, end: argument.span.end },
    };
  }
  return parsePostfix(p);
}

function parsePostfix(p: Parser): Expr {
  let expr = parsePrimary(p);
  for (;;) {
    if (at(p, "(")) {
      const args = parseArgList(p);
      const end = previous(p);
      expr = {
        kind: "call",
        callee: expr,
        typeArgs: [],
        args,
        span: { start: expr.span.start, end: end.span.end },
      };
      continue;
    }

    // Generic call: ident/member < TypeArgs > (
    if (
      at(p, "<") &&
      (expr.kind === "ident" || expr.kind === "member")
    ) {
      const checkpoint = p.index;
      const diagCount = p.diagnostics.length;
      const ta = tryParseTypeArgsThenCall(p);
      if (ta !== null) {
        expr = {
          kind: "call",
          callee: expr,
          typeArgs: ta.typeArgs,
          args: ta.args,
          span: { start: expr.span.start, end: ta.end },
        };
        continue;
      }
      p.index = checkpoint;
      p.diagnostics.length = diagCount;
      // Fall through — `<` is relational, stop postfix.
      break;
    }

    if (at(p, ".")) {
      advance(p);
      const prop = expectIdent(p);
      expr = {
        kind: "member",
        object: expr,
        property: prop.text,
        propertySpan: tokenSpan(prop),
        span: { start: expr.span.start, end: prop.span.end },
      };
      continue;
    }

    if (at(p, "[")) {
      advance(p);
      const index = parseExpr(p);
      const endTok = expect(p, "]", "`]`");
      expr = {
        kind: "index",
        object: expr,
        index,
        span: { start: expr.span.start, end: endTok.span.end },
      };
      continue;
    }

    if (atKeyword(p, "as")) {
      advance(p);
      const type = parseType(p);
      expr = {
        kind: "assert",
        expression: expr,
        type,
        span: { start: expr.span.start, end: type.span.end },
      };
      continue;
    }

    break;
  }
  return expr;
}

function tryParseTypeArgsThenCall(
  p: Parser,
): { typeArgs: TypeNode[]; args: Expr[]; end: SourcePosition } | null {
  if (!at(p, "<")) return null;
  // Parse type args; on failure return null (caller restores).
  advance(p); // <
  const typeArgs: TypeNode[] = [];
  if (!at(p, ">")) {
    for (;;) {
      // Type atoms that look like relational would fail; allow failure.
      const before = p.index;
      const t = parseType(p);
      if (p.index === before) {
        return null;
      }
      typeArgs.push(t);
      if (at(p, ",")) {
        advance(p);
        if (at(p, ">")) break;
        continue;
      }
      break;
    }
  }
  if (!at(p, ">")) return null;
  advance(p); // >
  if (!at(p, "(")) return null;
  const args = parseArgList(p);
  const end = previous(p).span.end;
  return { typeArgs, args, end };
}

function parseArgList(p: Parser): Expr[] {
  expect(p, "(", "`(`");
  const args: Expr[] = [];
  if (!at(p, ")")) {
    for (;;) {
      args.push(parseExpr(p));
      if (at(p, ",")) {
        advance(p);
        if (at(p, ")")) break;
        continue;
      }
      break;
    }
  }
  expect(p, ")", "`)`");
  return args;
}

function parsePrimary(p: Parser): Expr {
  const t = current(p);

  if (at(p, "number")) {
    advance(p);
    return {
      kind: "number",
      value: t.value as number,
      raw: t.text,
      span: tokenSpan(t),
    };
  }

  if (at(p, "string")) {
    advance(p);
    return {
      kind: "string",
      value: String(t.value ?? ""),
      span: tokenSpan(t),
    };
  }

  if (
    at(p, "template_no_sub") ||
    at(p, "template_head")
  ) {
    return parseTemplate(p);
  }

  if (atKeyword(p, "true") || atKeyword(p, "false")) {
    const tok = advance(p);
    return {
      kind: "boolean",
      value: tok.text === "true",
      span: tokenSpan(tok),
    };
  }

  if (atKeyword(p, "null")) {
    const tok = advance(p);
    return { kind: "null", span: tokenSpan(tok) };
  }

  if (atKeyword(p, "undefined")) {
    const tok = advance(p);
    return { kind: "undefined", span: tokenSpan(tok) };
  }

  if (atKeyword(p, "new")) {
    return parseNew(p);
  }

  if (at(p, "ident")) {
    // Bare ident => arrow is unsupported
    if (peek(p, 1).kind === "=>") {
      const id = advance(p);
      diag(
        p,
        "jsv.parse.unsupported",
        "unparenthesized arrow parameters are not supported",
        tokenSpan(id),
        "arrow parameters must be parenthesized and typed: (x: T) => ...",
      );
      advance(p); // =>
      const body = at(p, "{") ? parseBlock(p) : parseExpr(p);
      return {
        kind: "arrow",
        params: [],
        body,
        span: {
          start: id.span.start,
          end: "span" in body ? body.span.end : id.span.end,
        },
      };
    }
    const tok = advance(p);
    return { kind: "ident", name: tok.text, span: tokenSpan(tok) };
  }

  if (at(p, "[")) {
    return parseArrayLiteral(p);
  }

  if (at(p, "{")) {
    return parseObjectLiteral(p);
  }

  if (at(p, "(")) {
    // Could be parenthesized expr or arrow (params) =>
    return parseParenOrArrow(p);
  }

  // JSX only in primary position, so `a < b` stays a comparison.
  if (at(p, "<") && jsxAhead(p)) {
    return parseJsx(p);
  }

  // Unsupported lone | or & already handled in additive; here for primary errors.
  if (at(p, "|") || at(p, "&")) {
    const tok = advance(p);
    diag(
      p,
      "jsv.parse.unsupported_operator",
      `unsupported operator \`${tok.text}\` in expression`,
      tokenSpan(tok),
      "`||` and `&&` are the logical operators; `|` is only valid inside types",
    );
    return { kind: "ident", name: "_", span: tokenSpan(tok) };
  }

  unexpected(p, "expression");
  const tok = current(p);
  if (tok.kind !== "eof") {
    advance(p);
  }
  return { kind: "ident", name: "_", span: tokenSpan(tok) };
}

function jsxAhead(p: Parser): boolean {
  const next = peek(p, 1);
  return next.kind === "ident" || next.kind === "keyword" || next.kind === ">";
}

/**
 * Text that contains a newline is trimmed at both ends and internal line
 * breaks collapse to a single space. A chunk that is only whitespace is
 * dropped. Chunks with no newline keep their spaces, so `Hello {name}`
 * keeps the space.
 */
function normalizeJsxText(text: string): string | null {
  if (text.length === 0) return null;
  if (!text.includes("\n") && !text.includes("\r")) return text;
  let out = text.replace(/^[ \t]*(?:\r\n|\n|\r)[ \t\n\r]*/, "");
  out = out.replace(/[ \t\n\r]*(?:\r\n|\n|\r)[ \t]*$/, "");
  if (out.length === 0) return null;
  out = out.replace(/[ \t]*(?:\r\n|\n|\r)[ \t]*/g, " ");
  return out.length === 0 ? null : out;
}

function tagText(tag: string | null): string {
  return tag === null ? "fragment" : tag;
}

function parseJsx(p: Parser): Expr {
  const startTok = advance(p); // <
  if (at(p, ">")) {
    advance(p);
    const children = parseJsxChildren(p, null);
    return {
      kind: "jsx",
      tag: null,
      tagSpan: null,
      attributes: [],
      children,
      span: { start: startTok.span.start, end: previous(p).span.end },
    };
  }

  const nameTok = parseJsxTagName(p);
  const tag = nameTok.text;
  const tagSpan = tokenSpan(nameTok);
  const attributes: JsxAttribute[] = [];
  let selfClosing = false;

  while (!at(p, ">") && !at(p, "/") && !at(p, "eof") && !at(p, "<")) {
    const before = p.index;
    const attr = parseJsxAttribute(p);
    if (attr !== null) attributes.push(attr);
    if (p.index === before) {
      if (at(p, "eof")) break;
      advance(p);
    }
  }

  if (at(p, "/")) {
    advance(p);
    selfClosing = true;
  }
  let opened = false;
  if (at(p, ">")) {
    advance(p);
    opened = true;
  } else {
    diag(
      p,
      "jsv.parse.jsx_unclosed",
      `JSX element '${tagText(tag)}' is missing '>'`,
      { start: startTok.span.start, end: current(p).span.end },
      "close the tag with '>' or '/>'",
    );
  }

  const children =
    selfClosing || !opened ? [] : parseJsxChildren(p, tag);
  return {
    kind: "jsx",
    tag,
    tagSpan,
    attributes,
    children,
    span: { start: startTok.span.start, end: previous(p).span.end },
  };
}

function parseJsxTagName(p: Parser): Token {
  if (at(p, "ident") || at(p, "keyword")) return advance(p);
  unexpected(p, "JSX tag name");
  return current(p);
}

function parseJsxAttribute(p: Parser): JsxAttribute | null {
  if (at(p, "{")) {
    const tok = advance(p);
    diag(
      p,
      "jsv.parse.jsx_spread",
      "JSX spread attributes are not supported",
      tokenSpan(tok),
      "write each attribute as name={expr} or name=\"value\"",
    );
    if (!at(p, "}")) {
      parseExpr(p);
    }
    if (at(p, "}")) advance(p);
    return null;
  }

  if (!at(p, "ident") && !at(p, "keyword")) {
    unexpected(p, "JSX attribute");
    return null;
  }

  const nameTok = advance(p);
  if (!at(p, "=")) {
    diag(
      p,
      "jsv.parse.jsx_attribute",
      `JSX attribute '${nameTok.text}' requires a value`,
      tokenSpan(nameTok),
      "write name={expr} or name=\"value\"",
    );
    return null;
  }
  advance(p); // =

  let value: Expr;
  if (at(p, "string")) {
    const tok = advance(p);
    value = {
      kind: "string",
      value: String(tok.value ?? ""),
      span: tokenSpan(tok),
    };
  } else if (at(p, "{")) {
    const open = advance(p);
    if (at(p, "}")) {
      const close = advance(p);
      diag(
        p,
        "jsv.parse.jsx_empty",
        "JSX attribute value is empty",
        spanOf(open, close),
      );
      value = { kind: "ident", name: "_", span: spanOf(open, close) };
    } else {
      value = parseExpr(p);
      expect(p, "}", "`}`");
    }
  } else {
    const tok = current(p);
    diag(
      p,
      "jsv.parse.jsx_attribute",
      `JSX attribute '${nameTok.text}' requires a string or {expr} value`,
      tokenSpan(nameTok),
    );
    if (tok.kind !== "eof") advance(p);
    value = { kind: "ident", name: "_", span: tokenSpan(tok) };
  }

  return {
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    value,
    span: { start: nameTok.span.start, end: value.span.end },
  };
}

function parseJsxChildren(p: Parser, tag: string | null): JsxChild[] {
  const children: JsxChild[] = [];
  for (;;) {
    const scanned = scanJsxText(p.lexer);
    const normalized = normalizeJsxText(scanned.value);
    if (normalized !== null) {
      children.push({ kind: "text", value: normalized, span: scanned.span });
    }

    if (scanned.endedBy === "eof") {
      diag(
        p,
        "jsv.parse.jsx_unclosed",
        `JSX element '${tagText(tag)}' is missing a closing tag`,
        scanned.span,
        tag === null ? "close the fragment with '</>'" : `close it with '</${tag}>'`,
      );
      break;
    }

    if (scanned.endedBy === "lbrace") {
      const open = expect(p, "{", "`{`");
      if (at(p, "}")) {
        const close = advance(p);
        diag(
          p,
          "jsv.parse.jsx_empty",
          "JSX expression child is empty",
          spanOf(open, close),
        );
        continue;
      }
      const expr = parseExpr(p);
      const close = expect(p, "}", "`}`");
      children.push({
        kind: "expr",
        expr,
        span: { start: open.span.start, end: close.span.end },
      });
      continue;
    }

    // `<` starts a nested element or the closing tag.
    if (peek(p, 1).kind === "/") {
      parseJsxClose(p, tag);
      break;
    }
    const nested = parseJsx(p);
    children.push({ kind: "expr", expr: nested, span: nested.span });
  }
  return children;
}

function parseJsxClose(p: Parser, tag: string | null): void {
  expect(p, "<", "`<`");
  expect(p, "/", "`/`");
  if (tag === null) {
    if (at(p, "ident") || at(p, "keyword")) {
      const nameTok = advance(p);
      diag(
        p,
        "jsv.parse.jsx_mismatch",
        `Closing tag '</${nameTok.text}>' does not match fragment '<>'`,
        tokenSpan(nameTok),
      );
    }
    expect(p, ">", "`>`");
    return;
  }
  if (!at(p, "ident") && !at(p, "keyword")) {
    diag(
      p,
      "jsv.parse.jsx_mismatch",
      `Closing tag for '${tag}' is missing its name`,
      tokenSpan(current(p)),
      `expected '</${tag}>'`,
    );
    if (at(p, ">")) advance(p);
    return;
  }
  const nameTok = advance(p);
  if (nameTok.text !== tag) {
    diag(
      p,
      "jsv.parse.jsx_mismatch",
      `Closing tag '</${nameTok.text}>' does not match '<${tag}>'`,
      tokenSpan(nameTok),
      `expected '</${tag}>'`,
    );
  }
  expect(p, ">", "`>`");
}

function parseTemplate(p: Parser): Expr {
  const startTok = current(p);
  const parts: Array<
    { kind: "text"; value: string } | { kind: "expr"; expr: Expr }
  > = [];

  if (at(p, "template_no_sub")) {
    const tok = advance(p);
    parts.push({ kind: "text", value: String(tok.value ?? "") });
    return {
      kind: "template",
      parts,
      span: tokenSpan(tok),
    };
  }

  // template_head
  const head = advance(p);
  parts.push({ kind: "text", value: String(head.value ?? "") });

  for (;;) {
    const expr = parseExpr(p);
    parts.push({ kind: "expr", expr });
    // Next token should be template_middle or template_tail (lexer emits after `}`)
    if (at(p, "template_middle")) {
      const mid = advance(p);
      parts.push({ kind: "text", value: String(mid.value ?? "") });
      continue;
    }
    if (at(p, "template_tail")) {
      const tail = advance(p);
      parts.push({ kind: "text", value: String(tail.value ?? "") });
      return {
        kind: "template",
        parts,
        span: { start: startTok.span.start, end: tail.span.end },
      };
    }
    // Missing middle/tail — the `}` was a block brace, not template.
    unexpected(p, "template continuation");
    return {
      kind: "template",
      parts,
      span: { start: startTok.span.start, end: expr.span.end },
    };
  }
}

function parseNew(p: Parser): Expr {
  const startTok = expectKeyword(p, "new");
  // PrimaryWithoutNew: ident / member chain / paren
  let callee: Expr;
  if (at(p, "ident")) {
    const id = advance(p);
    callee = { kind: "ident", name: id.text, span: tokenSpan(id) };
    while (at(p, ".")) {
      advance(p);
      const prop = expectIdent(p);
      callee = {
        kind: "member",
        object: callee,
        property: prop.text,
        propertySpan: tokenSpan(prop),
        span: { start: callee.span.start, end: prop.span.end },
      };
    }
  } else if (at(p, "(")) {
    advance(p);
    callee = parseExpr(p);
    expect(p, ")", "`)`");
  } else {
    unexpected(p, "constructor name");
    callee = { kind: "ident", name: "_", span: tokenSpan(current(p)) };
  }

  let typeArgs: TypeNode[] = [];
  if (at(p, "<")) {
    const ta = parseTypeArgs(p);
    typeArgs = ta.args;
  }

  const args = parseArgList(p);
  const end = previous(p);
  return {
    kind: "new",
    callee,
    typeArgs,
    args,
    span: { start: startTok.span.start, end: end.span.end },
  };
}

function parseArrayLiteral(p: Parser): Expr {
  const startTok = expect(p, "[", "`[`");
  const elements: Expr[] = [];
  if (!at(p, "]")) {
    for (;;) {
      elements.push(parseExpr(p));
      if (at(p, ",")) {
        advance(p);
        if (at(p, "]")) break;
        continue;
      }
      break;
    }
  }
  const endTok = expect(p, "]", "`]`");
  return {
    kind: "array",
    elements,
    span: spanOf(startTok, endTok),
  };
}

function parseObjectLiteral(p: Parser): Expr {
  const startTok = expect(p, "{", "`{`");
  const properties: {
    name: string;
    nameSpan: Span;
    shorthand: boolean;
    value: Expr;
    span: Span;
  }[] = [];

  if (!at(p, "}")) {
    for (;;) {
      const nameTok = expectIdent(p);
      if (at(p, ":")) {
        advance(p);
        const value = parseExpr(p);
        properties.push({
          name: nameTok.text,
          nameSpan: tokenSpan(nameTok),
          shorthand: false,
          value,
          span: { start: nameTok.span.start, end: value.span.end },
        });
      } else {
        // Shorthand
        const value: Expr = {
          kind: "ident",
          name: nameTok.text,
          span: tokenSpan(nameTok),
        };
        properties.push({
          name: nameTok.text,
          nameSpan: tokenSpan(nameTok),
          shorthand: true,
          value,
          span: tokenSpan(nameTok),
        });
      }
      if (at(p, ",")) {
        advance(p);
        if (at(p, "}")) break;
        continue;
      }
      break;
    }
  }
  const endTok = expect(p, "}", "`}`");
  return {
    kind: "object",
    properties,
    span: spanOf(startTok, endTok),
  };
}

function parseParenOrArrow(p: Parser): Expr {
  const checkpoint = p.index;
  const diagCount = p.diagnostics.length;
  const startTok = advance(p); // (

  // Try arrow: ( ParamList ) =>
  // ParamList requires ident : type
  let isArrow = false;
  if (at(p, ")")) {
    // () => ...
    advance(p);
    if (at(p, "=>")) {
      isArrow = true;
    }
  } else if (at(p, "ident") && peek(p, 1).kind === ":") {
    isArrow = true; // likely
  }

  if (isArrow) {
    p.index = checkpoint;
    p.diagnostics.length = diagCount;
    return parseArrow(p);
  }

  // Parenthesized expression
  p.index = checkpoint;
  p.diagnostics.length = diagCount;
  advance(p); // (
  const expr = parseExpr(p);
  const endTok = expect(p, ")", "`)`");
  // If ) => then it was actually an arrow with a single weird param — but
  // params require types, so treat as paren expr. If we see => after ), error.
  if (at(p, "=>")) {
    // Restore and parse as arrow attempt for better errors
    p.index = checkpoint;
    p.diagnostics.length = diagCount;
    return parseArrow(p);
  }
  return { ...expr, span: { start: startTok.span.start, end: endTok.span.end } };
}

function parseArrow(p: Parser): Expr {
  const startTok = current(p);
  const params = parseParamList(p);
  expect(p, "=>", "`=>`");
  let body: Expr | Block;
  if (at(p, "{")) {
    body = parseBlock(p);
  } else {
    body = parseExpr(p);
  }
  return {
    kind: "arrow",
    params,
    body,
    span: {
      start: startTok.span.start,
      end: body.span.end,
    },
  };
}

// ---------- Statements ----------

function parseBlock(p: Parser): Block {
  const startTok = expect(p, "{", "`{`");
  const body: Statement[] = [];
  while (!at(p, "}") && !at(p, "eof")) {
    const before = p.index;
    body.push(parseStatement(p));
    ensureProgress(p, before);
  }
  const endTok = expect(p, "}", "`}`");
  return {
    kind: "block",
    body,
    span: spanOf(startTok, endTok),
  };
}

function parseStatement(p: Parser): Statement {
  if (at(p, ";")) {
    const tok = advance(p);
    return { kind: "empty", span: tokenSpan(tok) };
  }

  if (atKeyword(p, "import")) {
    return parseImport(p);
  }

  if (atKeyword(p, "export")) {
    return parseExportable(p);
  }

  if (atKeyword(p, "let") || atKeyword(p, "const")) {
    return parseVar(p, false, false);
  }

  if (atKeyword(p, "function")) {
    return parseFunction(p, false, false);
  }

  if (atKeyword(p, "type")) {
    return parseTypeAlias(p, false);
  }

  if (atKeyword(p, "interface")) {
    return parseInterface(p, false);
  }

  if (atKeyword(p, "class")) {
    return parseClass(p, false, false);
  }

  if (atKeyword(p, "if")) {
    return parseIf(p);
  }

  if (atKeyword(p, "while")) {
    return parseWhile(p);
  }

  if (atKeyword(p, "for")) {
    return parseFor(p);
  }

  if (atKeyword(p, "return")) {
    return parseReturn(p);
  }

  if (at(p, "{")) {
    return parseBlock(p);
  }

  // Expression statement
  const startIndex = p.index;
  const expr = parseExpr(p);
  if (!at(p, ";")) {
    unexpected(p, "`;`");
    // Recovery: skip to ; or }
    if (p.index === startIndex) {
      advance(p);
    }
    recoverStatement(p);
    return {
      kind: "expr_stmt",
      expression: expr,
      span: expr.span,
    };
  }
  const semi = advance(p);
  return {
    kind: "expr_stmt",
    expression: expr,
    span: { start: expr.span.start, end: semi.span.end },
  };
}

function parseExportable(p: Parser): Statement {
  const exportTok = expectKeyword(p, "export");
  let defaultExport = false;
  if (atKeyword(p, "default")) {
    advance(p);
    defaultExport = true;
  }

  if (atKeyword(p, "function")) {
    return parseFunction(p, true, defaultExport);
  }
  if (atKeyword(p, "class")) {
    return parseClass(p, true, defaultExport);
  }
  if (atKeyword(p, "let") || atKeyword(p, "const")) {
    return parseVar(p, true, defaultExport);
  }
  if (atKeyword(p, "type")) {
    if (defaultExport) {
      diag(
        p,
        "jsv.parse.invalid_default_export",
        "`export default` is not allowed on type aliases",
        tokenSpan(exportTok),
      );
    }
    return parseTypeAlias(p, true);
  }
  if (atKeyword(p, "interface")) {
    if (defaultExport) {
      diag(
        p,
        "jsv.parse.invalid_default_export",
        "`export default` is not allowed on interfaces",
        tokenSpan(exportTok),
      );
    }
    return parseInterface(p, true);
  }

  unexpected(p, "declaration after `export`");
  recoverStatement(p);
  return { kind: "empty", span: tokenSpan(exportTok) };
}

function parseImport(p: Parser): ImportStmt {
  const startTok = expectKeyword(p, "import");
  let defaultName: string | null = null;
  let defaultSpan: Span | null = null;
  const names: { imported: string; local: string; span: Span }[] = [];

  if (at(p, "ident")) {
    const id = advance(p);
    defaultName = id.text;
    defaultSpan = tokenSpan(id);
    if (at(p, ",")) {
      advance(p);
      parseImportNamed(p, names);
    }
  } else if (at(p, "{")) {
    parseImportNamed(p, names);
  } else {
    unexpected(p, "import binding");
  }

  expectKeyword(p, "from");
  let moduleSpecifier = "";
  if (at(p, "string")) {
    const s = advance(p);
    moduleSpecifier = String(s.value ?? "");
  } else {
    unexpected(p, "string module specifier");
  }
  const semi = expect(p, ";", "`;`");
  return {
    kind: "import",
    defaultName,
    defaultSpan,
    names,
    moduleSpecifier,
    span: spanOf(startTok, semi),
  };
}

function parseImportNamed(
  p: Parser,
  names: { imported: string; local: string; span: Span }[],
): void {
  expect(p, "{", "`{`");
  if (!at(p, "}")) {
    for (;;) {
      const imported = expectIdent(p);
      let local = imported.text;
      let end = imported.span.end;
      if (atKeyword(p, "as")) {
        advance(p);
        const loc = expectIdent(p);
        local = loc.text;
        end = loc.span.end;
      }
      names.push({
        imported: imported.text,
        local,
        span: { start: imported.span.start, end },
      });
      if (at(p, ",")) {
        advance(p);
        if (at(p, "}")) break;
        continue;
      }
      break;
    }
  }
  expect(p, "}", "`}`");
}

function parseVar(
  p: Parser,
  exported: boolean,
  defaultExport: boolean,
): VarStmt {
  const kindTok = advance(p); // let | const
  const declKind = kindTok.text as "let" | "const";
  const nameTok = expectIdent(p);
  let type: TypeNode | null = null;
  if (at(p, ":")) {
    advance(p);
    type = parseType(p);
  }
  let init: Expr | null = null;
  if (at(p, "=")) {
    advance(p);
    init = parseExpr(p);
  } else if (declKind === "const") {
    diag(
      p,
      "jsv.parse.const_missing_init",
      "`const` declaration requires an initializer",
      tokenSpan(nameTok),
    );
  }
  // In for-init, semicolon is NOT consumed here — caller handles it.
  // For normal statements, require `;`.
  // We detect for-init via a flag... simpler: always expect `;` here, and
  // for-init uses parseVarInFor instead.
  const semi = expect(p, ";", "`;`");
  return {
    kind: "var",
    declKind,
    exported,
    defaultExport,
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    type,
    init,
    span: { start: kindTok.span.start, end: semi.span.end },
  };
}

function parseVarInFor(p: Parser): VarStmt {
  const kindTok = advance(p); // let | const
  const declKind = kindTok.text as "let" | "const";
  const nameTok = expectIdent(p);
  let type: TypeNode | null = null;
  if (at(p, ":")) {
    advance(p);
    type = parseType(p);
  }
  let init: Expr | null = null;
  if (at(p, "=")) {
    advance(p);
    init = parseExpr(p);
  } else if (declKind === "const") {
    diag(
      p,
      "jsv.parse.const_missing_init",
      "`const` declaration requires an initializer",
      tokenSpan(nameTok),
    );
  }
  const end = init?.span.end ?? type?.span.end ?? nameTok.span.end;
  return {
    kind: "var",
    declKind,
    exported: false,
    defaultExport: false,
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    type,
    init,
    span: { start: kindTok.span.start, end },
  };
}

function parseFunction(
  p: Parser,
  exported: boolean,
  defaultExport: boolean,
): FunctionDecl {
  const startTok = expectKeyword(p, "function");
  const nameTok = expectIdent(p);
  const typeParams = parseTypeParams(p);
  const params = parseParamList(p);
  if (!at(p, ":")) {
    diag(
      p,
      "jsv.parse.unexpected_token",
      "function return type is required",
      tokenSpan(current(p)),
    );
  } else {
    advance(p);
  }
  const returnType = at(p, "{")
    ? ({
        kind: "prim",
        name: "unknown",
        span: tokenSpan(current(p)),
      } satisfies TypeNode)
    : parseType(p);
  const body = parseBlock(p);
  return {
    kind: "function",
    exported,
    defaultExport,
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    typeParams,
    params,
    returnType,
    body,
    span: { start: startTok.span.start, end: body.span.end },
  };
}

function parseTypeAlias(p: Parser, exported: boolean): TypeAlias {
  const startTok = expectKeyword(p, "type");
  const nameTok = expectIdent(p);
  const typeParams = parseTypeParams(p);
  expect(p, "=", "`=`");
  const type = parseType(p);
  const semi = expect(p, ";", "`;`");
  return {
    kind: "type_alias",
    exported,
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    typeParams,
    type,
    span: spanOf(startTok, semi),
  };
}

function parseInterface(p: Parser, exported: boolean): InterfaceDecl {
  const startTok = expectKeyword(p, "interface");
  const nameTok = expectIdent(p);
  const typeParams = parseTypeParams(p);
  expect(p, "{", "`{`");
  const members: TypeMember[] = [];
  while (!at(p, "}") && !at(p, "eof")) {
    const before = p.index;
    members.push(parseTypeMember(p));
    ensureProgress(p, before);
  }
  const endTok = expect(p, "}", "`}`");
  return {
    kind: "interface",
    exported,
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    typeParams,
    members,
    span: spanOf(startTok, endTok),
  };
}

function parseClass(
  p: Parser,
  exported: boolean,
  defaultExport: boolean,
): ClassDecl {
  const startTok = expectKeyword(p, "class");
  const nameTok = expectIdent(p);

  // Unsupported: extends / implements
  if (at(p, "ident") && (current(p).text === "extends" || current(p).text === "implements")) {
    const tok = advance(p);
    diag(
      p,
      "jsv.parse.unsupported",
      `\`${tok.text}\` is not supported`,
      tokenSpan(tok),
    );
    // Skip the heritage type name(s) roughly
    while (
      !at(p, "{") &&
      !at(p, "eof") &&
      !at(p, ";")
    ) {
      advance(p);
    }
  }

  expect(p, "{", "`{`");
  const members: ClassMember[] = [];
  while (!at(p, "}") && !at(p, "eof")) {
    const before = p.index;
    members.push(parseClassMember(p));
    ensureProgress(p, before);
  }
  const endTok = expect(p, "}", "`}`");
  return {
    kind: "class",
    exported,
    defaultExport,
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    members,
    span: spanOf(startTok, endTok),
  };
}

function parseClassMember(p: Parser): ClassMember {
  // Unsupported modifiers
  while (
    at(p, "ident") &&
    (current(p).text === "public" ||
      current(p).text === "private" ||
      current(p).text === "static" ||
      current(p).text === "readonly")
  ) {
    const tok = advance(p);
    diag(
      p,
      "jsv.parse.unsupported",
      `\`${tok.text}\` is not supported`,
      tokenSpan(tok),
    );
  }

  if (atKeyword(p, "constructor")) {
    const startTok = advance(p);
    const params = parseParamList(p);
    const body = parseBlock(p);
    return {
      kind: "constructor",
      params,
      body,
      span: { start: startTok.span.start, end: body.span.end },
    };
  }

  if (!at(p, "ident")) {
    const tok = current(p);
    unexpected(p, "identifier");
    recoverMember(p);
    return {
      kind: "field",
      name: "_",
      nameSpan: tokenSpan(tok),
      type: { kind: "prim", name: "unknown", span: tokenSpan(tok) },
      span: tokenSpan(tok),
    };
  }
  const nameTok = advance(p);
  const typeParams = at(p, "<") ? parseTypeParams(p) : [];

  if (at(p, "(") || typeParams.length > 0) {
    const params = parseParamList(p);
    if (!at(p, ":")) {
      diag(
        p,
        "jsv.parse.unexpected_token",
        "method return type is required",
        tokenSpan(current(p)),
      );
    } else {
      advance(p);
    }
    const returnType = at(p, "{")
      ? ({
          kind: "prim",
          name: "unknown",
          span: tokenSpan(current(p)),
        } satisfies TypeNode)
      : parseType(p);
    const body = parseBlock(p);
    return {
      kind: "method",
      name: nameTok.text,
      nameSpan: tokenSpan(nameTok),
      typeParams,
      params,
      returnType,
      body,
      span: { start: nameTok.span.start, end: body.span.end },
    };
  }

  // Field
  expect(p, ":", "`:`");
  const type = parseType(p);
  if (at(p, "=")) {
    const eq = advance(p);
    diag(
      p,
      "jsv.parse.unexpected_token",
      "field initializers are not supported",
      tokenSpan(eq),
    );
    // Skip initializer expression roughly
    parseExpr(p);
  }
  const semi = expect(p, ";", "`;`");
  return {
    kind: "field",
    name: nameTok.text,
    nameSpan: tokenSpan(nameTok),
    type,
    span: { start: nameTok.span.start, end: semi.span.end },
  };
}

function parseIf(p: Parser): IfStmt {
  const startTok = expectKeyword(p, "if");
  expect(p, "(", "`(`");
  const test = parseExpr(p);
  expect(p, ")", "`)`");
  const consequent = parseStatement(p);
  let alternate: Statement | null = null;
  if (atKeyword(p, "else")) {
    advance(p);
    alternate = parseStatement(p);
  }
  const end = alternate?.span.end ?? consequent.span.end;
  return {
    kind: "if",
    test,
    consequent,
    alternate,
    span: { start: startTok.span.start, end },
  };
}

function parseWhile(p: Parser): WhileStmt {
  const startTok = expectKeyword(p, "while");
  expect(p, "(", "`(`");
  const test = parseExpr(p);
  expect(p, ")", "`)`");
  const body = parseStatement(p);
  return {
    kind: "while",
    test,
    body,
    span: { start: startTok.span.start, end: body.span.end },
  };
}

function parseFor(p: Parser): ForStmt {
  const startTok = expectKeyword(p, "for");
  expect(p, "(", "`(`");

  let init: VarStmt | Expr | null = null;
  if (!at(p, ";")) {
    if (atKeyword(p, "let") || atKeyword(p, "const")) {
      init = parseVarInFor(p);
    } else {
      init = parseExpr(p);
    }
  }
  expect(p, ";", "`;`");

  let test: Expr | null = null;
  if (!at(p, ";")) {
    test = parseExpr(p);
  }
  expect(p, ";", "`;`");

  let update: Expr | null = null;
  if (!at(p, ")")) {
    update = parseExpr(p);
  }
  expect(p, ")", "`)`");
  const body = parseStatement(p);
  return {
    kind: "for",
    init,
    test,
    update,
    body,
    span: { start: startTok.span.start, end: body.span.end },
  };
}

function parseReturn(p: Parser): ReturnStmt {
  const startTok = expectKeyword(p, "return");
  let argument: Expr | null = null;
  if (!at(p, ";") && !at(p, "}") && !at(p, "eof")) {
    argument = parseExpr(p);
  }
  const semi = expect(p, ";", "`;`");
  return {
    kind: "return",
    argument,
    span: spanOf(startTok, semi),
  };
}

export function parseProgram(
  lexer: LexerState,
): { program: Program; diagnostics: Diagnostic[] } {
  const p: Parser = {
    lexer,
    index: 0,
    file: lexer.file,
    diagnostics: lexer.diagnostics,
  };

  const body: Statement[] = [];
  const startPos: SourcePosition = current(p).span.start;

  while (!at(p, "eof")) {
    const before = p.index;
    const stmt = parseStatement(p);
    body.push(stmt);
    if (p.index === before) {
      // Ensure progress
      advance(p);
    }
  }

  const endPos =
    p.lexer.tokens.length > 0
      ? p.lexer.tokens[p.lexer.tokens.length - 1]!.span.end
      : startPos;

  const program: Program = {
    kind: "program",
    body,
    span: { start: startPos, end: endPos },
  };

  return { program, diagnostics: p.diagnostics };
}
