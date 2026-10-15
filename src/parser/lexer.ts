import type { Diagnostic, SourcePosition } from "../diagnostics.ts";
import type { Span } from "./ast.ts";

export type TokenKind =
  | "ident"
  | "number"
  | "string"
  | "template_head"
  | "template_middle"
  | "template_tail"
  | "template_no_sub"
  | "keyword"
  | "("
  | ")"
  | "{"
  | "}"
  | "["
  | "]"
  | ","
  | ";"
  | ":"
  | "?"
  | "."
  | "=>"
  | "="
  | "=="
  | "==="
  | "!="
  | "!=="
  | "<="
  | ">="
  | "<"
  | ">"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "!"
  | "||"
  | "&&"
  | "|"
  | "&"
  | "eof"
  | "error";

export type Token = {
  kind: TokenKind;
  text: string;
  value?: string | number;
  span: Span;
};

export const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "default",
  "function",
  "let",
  "const",
  "type",
  "interface",
  "class",
  "if",
  "else",
  "while",
  "for",
  "return",
  "true",
  "false",
  "null",
  "undefined",
  "string",
  "number",
  "boolean",
  "void",
  "never",
  "unknown",
  "constructor",
  "as",
  "new",
]);

type BraceFrame = "block" | "template";

type LexerState = {
  source: string;
  file: string;
  index: number;
  line: number;
  column: number;
  tokens: Token[];
  diagnostics: Diagnostic[];
  braces: BraceFrame[];
};

function pos(state: LexerState): SourcePosition {
  return { line: state.line, column: state.column };
}

function peek(state: LexerState, offset = 0): string {
  return state.source[state.index + offset] ?? "";
}

function advance(state: LexerState): string {
  const ch = state.source[state.index] ?? "";
  state.index += 1;
  if (ch === "\n") {
    state.line += 1;
    state.column = 1;
  } else if (ch !== "") {
    state.column += 1;
  }
  return ch;
}

/** Inclusive end position of the character just consumed. */
function lastCharPos(state: LexerState): SourcePosition {
  if (state.index === 0) {
    return { line: 1, column: 1 };
  }
  const i = state.index - 1;
  const ch = state.source[i] ?? "";
  if (ch === "\n") {
    // The newline character sits at the end of the previous visual line.
    let lineStart = i;
    while (lineStart > 0 && state.source[lineStart - 1] !== "\n") {
      lineStart -= 1;
    }
    let line = 1;
    for (let j = 0; j < i; j++) {
      if (state.source[j] === "\n") {
        line += 1;
      }
    }
    return { line, column: i - lineStart + 1 };
  }
  return { line: state.line, column: state.column - 1 };
}

function makeDiag(
  state: LexerState,
  code: string,
  message: string,
  start: SourcePosition,
  end: SourcePosition,
  hint?: string,
): Diagnostic {
  const d: Diagnostic = {
    code,
    severity: "error",
    message,
    file: state.file,
    start,
    end,
  };
  if (hint !== undefined) {
    d.hint = hint;
  }
  return d;
}

function pushToken(
  state: LexerState,
  kind: TokenKind,
  text: string,
  start: SourcePosition,
  end: SourcePosition,
  value?: string | number,
): void {
  const token: Token = { kind, text, span: { start, end } };
  if (value !== undefined) {
    token.value = value;
  }
  state.tokens.push(token);
}

function isIdentStart(ch: string): boolean {
  return (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || ch === "_";
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= "0" && ch <= "9");
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function isHex(ch: string): boolean {
  return (
    isDigit(ch) ||
    (ch >= "a" && ch <= "f") ||
    (ch >= "A" && ch <= "F")
  );
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\r" || ch === "\n";
}

function skipWhitespaceAndComments(state: LexerState): void {
  for (;;) {
    const ch = peek(state);
    if (isWhitespace(ch)) {
      advance(state);
      continue;
    }
    if (ch === "/" && peek(state, 1) === "/") {
      advance(state);
      advance(state);
      while (peek(state) !== "" && peek(state) !== "\n") {
        advance(state);
      }
      continue;
    }
    if (ch === "/" && peek(state, 1) === "*") {
      const start = pos(state);
      advance(state);
      advance(state);
      let closed = false;
      while (peek(state) !== "") {
        if (peek(state) === "*" && peek(state, 1) === "/") {
          advance(state);
          advance(state);
          closed = true;
          break;
        }
        advance(state);
      }
      if (!closed) {
        const end =
          state.index > 0 ? lastCharPos(state) : pos(state);
        state.diagnostics.push(
          makeDiag(
            state,
            "jsv.parse.unterminated_comment",
            "unterminated block comment",
            start,
            end,
          ),
        );
      }
      continue;
    }
    break;
  }
}

function readEscape(state: LexerState, escStart: SourcePosition): string {
  const esc = advance(state);
  if (esc === "") {
    return "";
  }
  switch (esc) {
    case "\\":
      return "\\";
    case "'":
      return "'";
    case '"':
      return '"';
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "`":
      return "`";
    case "$":
      return "$";
    case "u": {
      let hex = "";
      let ok = true;
      for (let i = 0; i < 4; i++) {
        const h = peek(state);
        if (!isHex(h)) {
          ok = false;
          break;
        }
        hex += advance(state);
      }
      if (!ok || hex.length < 4) {
        state.diagnostics.push(
          makeDiag(
            state,
            "jsv.parse.invalid_escape",
            "invalid unicode escape: expected 4 hex digits after \\u",
            escStart,
            state.index > 0 ? lastCharPos(state) : escStart,
          ),
        );
        return "u" + hex;
      }
      return String.fromCharCode(parseInt(hex, 16));
    }
    default: {
      state.diagnostics.push(
        makeDiag(
          state,
          "jsv.parse.invalid_escape",
          `invalid escape sequence: \\${esc}`,
          escStart,
          lastCharPos(state),
        ),
      );
      return esc;
    }
  }
}

function readString(state: LexerState, quote: '"' | "'"): void {
  const start = pos(state);
  const startIndex = state.index;
  advance(state);
  let value = "";
  let closed = false;
  while (peek(state) !== "") {
    const ch = peek(state);
    if (ch === "\n") {
      break;
    }
    if (ch === quote) {
      advance(state);
      closed = true;
      break;
    }
    if (ch === "\\") {
      const escStart = pos(state);
      advance(state);
      value += readEscape(state, escStart);
      continue;
    }
    value += advance(state);
  }
  const end = state.index > 0 ? lastCharPos(state) : start;
  const text = state.source.slice(startIndex, state.index);
  if (!closed) {
    state.diagnostics.push(
      makeDiag(
        state,
        "jsv.parse.unterminated_string",
        "unterminated string literal",
        start,
        end,
      ),
    );
    pushToken(state, "error", text, start, end);
    return;
  }
  pushToken(state, "string", text, start, end, value);
}

function readNumber(state: LexerState): void {
  const start = pos(state);
  const startIndex = state.index;
  let invalid = false;

  if (peek(state) === "0") {
    advance(state);
    if (isDigit(peek(state))) {
      invalid = true;
      while (isDigit(peek(state))) {
        advance(state);
      }
    }
  } else {
    while (isDigit(peek(state))) {
      advance(state);
    }
  }

  if (peek(state) === "." && isDigit(peek(state, 1))) {
    advance(state);
    while (isDigit(peek(state))) {
      advance(state);
    }
  }

  if (peek(state) === "e" || peek(state) === "E") {
    const afterE = peek(state, 1);
    if (afterE === "+" || afterE === "-" || isDigit(afterE)) {
      advance(state);
      if (peek(state) === "+" || peek(state) === "-") {
        advance(state);
      }
      if (!isDigit(peek(state))) {
        invalid = true;
      } else {
        while (isDigit(peek(state))) {
          advance(state);
        }
      }
    } else {
      advance(state);
      invalid = true;
    }
  }

  if (isIdentStart(peek(state))) {
    invalid = true;
    while (isIdentPart(peek(state))) {
      advance(state);
    }
  }

  const end = lastCharPos(state);
  const text = state.source.slice(startIndex, state.index);
  if (invalid) {
    state.diagnostics.push(
      makeDiag(
        state,
        "jsv.parse.invalid_number",
        `invalid number literal: ${text}`,
        start,
        end,
      ),
    );
    pushToken(state, "error", text, start, end);
    return;
  }
  pushToken(state, "number", text, start, end, Number(text));
}

function readTemplate(state: LexerState, isHead: boolean): void {
  const start = pos(state);
  const startIndex = state.index;
  if (isHead) {
    advance(state);
  }
  let value = "";

  while (peek(state) !== "") {
    const ch = peek(state);
    if (ch === "`") {
      advance(state);
      const end = lastCharPos(state);
      const text = state.source.slice(startIndex, state.index);
      const kind: TokenKind = isHead ? "template_no_sub" : "template_tail";
      pushToken(state, kind, text, start, end, value);
      return;
    }
    if (ch === "$" && peek(state, 1) === "{") {
      advance(state);
      advance(state);
      const end = lastCharPos(state);
      const text = state.source.slice(startIndex, state.index);
      const kind: TokenKind = isHead ? "template_head" : "template_middle";
      pushToken(state, kind, text, start, end, value);
      state.braces.push("template");
      return;
    }
    if (ch === "\\") {
      const escStart = pos(state);
      advance(state);
      value += readEscape(state, escStart);
      continue;
    }
    value += advance(state);
  }

  const end = state.index > 0 ? lastCharPos(state) : start;
  state.diagnostics.push(
    makeDiag(
      state,
      "jsv.parse.unterminated_template",
      "unterminated template literal",
      start,
      end,
    ),
  );
  pushToken(
    state,
    "error",
    state.source.slice(startIndex, state.index),
    start,
    end,
  );
}

function readIdentOrKeyword(state: LexerState): void {
  const start = pos(state);
  const startIndex = state.index;
  while (isIdentPart(peek(state))) {
    advance(state);
  }
  const end = lastCharPos(state);
  const text = state.source.slice(startIndex, state.index);
  if (KEYWORDS.has(text)) {
    pushToken(state, "keyword", text, start, end);
  } else {
    pushToken(state, "ident", text, start, end);
  }
}

function emitPunct(state: LexerState): boolean {
  const ch = peek(state);
  const start = pos(state);
  const two = ch + peek(state, 1);
  const three = two + peek(state, 2);

  if (three === "===" || three === "!==") {
    advance(state);
    advance(state);
    advance(state);
    pushToken(state, three, three, start, lastCharPos(state));
    return true;
  }

  if (
    two === "=>" ||
    two === "==" ||
    two === "!=" ||
    two === "<=" ||
    two === ">=" ||
    two === "||" ||
    two === "&&"
  ) {
    advance(state);
    advance(state);
    pushToken(state, two as TokenKind, two, start, lastCharPos(state));
    return true;
  }

  const singles: Record<string, TokenKind> = {
    "(": "(",
    ")": ")",
    "[": "[",
    "]": "]",
    ",": ",",
    ";": ";",
    ":": ":",
    "?": "?",
    ".": ".",
    "=": "=",
    "<": "<",
    ">": ">",
    "+": "+",
    "-": "-",
    "*": "*",
    "/": "/",
    "%": "%",
    "!": "!",
    "|": "|",
    "&": "&",
  };

  const kind = singles[ch];
  if (kind !== undefined) {
    advance(state);
    pushToken(state, kind, ch, start, lastCharPos(state));
    return true;
  }
  return false;
}

function nextToken(state: LexerState): void {
  skipWhitespaceAndComments(state);
  if (peek(state) === "") {
    const p = pos(state);
    pushToken(state, "eof", "", p, p);
    return;
  }

  const ch = peek(state);

  if (ch === "{") {
    const start = pos(state);
    advance(state);
    pushToken(state, "{", "{", start, lastCharPos(state));
    state.braces.push("block");
    return;
  }

  if (ch === "}") {
    const top = state.braces[state.braces.length - 1];
    if (top === "template") {
      // Consume `}` as the end of `${...}`; do not emit it as a token.
      advance(state);
      state.braces.pop();
      readTemplate(state, false);
      return;
    }
    const start = pos(state);
    advance(state);
    pushToken(state, "}", "}", start, lastCharPos(state));
    if (top === "block") {
      state.braces.pop();
    }
    return;
  }

  if (ch === "`") {
    readTemplate(state, true);
    return;
  }

  if (isIdentStart(ch)) {
    readIdentOrKeyword(state);
    return;
  }
  if (isDigit(ch)) {
    readNumber(state);
    return;
  }
  if (ch === '"' || ch === "'") {
    readString(state, ch);
    return;
  }
  if (emitPunct(state)) {
    return;
  }

  const start = pos(state);
  advance(state);
  const end = lastCharPos(state);
  state.diagnostics.push(
    makeDiag(
      state,
      "jsv.parse.unexpected_token",
      `unexpected character: ${JSON.stringify(ch)}`,
      start,
      end,
    ),
  );
  pushToken(state, "error", ch, start, end);
}

export function tokenize(
  source: string,
  file: string,
): { tokens: Token[]; diagnostics: Diagnostic[] } {
  const state: LexerState = {
    source,
    file,
    index: 0,
    line: 1,
    column: 1,
    tokens: [],
    diagnostics: [],
    braces: [],
  };

  for (;;) {
    nextToken(state);
    const last = state.tokens[state.tokens.length - 1];
    if (last?.kind === "eof") {
      break;
    }
  }

  return { tokens: state.tokens, diagnostics: state.diagnostics };
}
