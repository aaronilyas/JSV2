import assert from "node:assert/strict";
import { test } from "node:test";
import { tokenize } from "../../src/parser/lexer.ts";

test("empty source yields only eof", () => {
  const { tokens, diagnostics } = tokenize("", "t.jsv");
  assert.equal(diagnostics.length, 0);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0]?.kind, "eof");
});

test("comments are skipped", () => {
  const { tokens, diagnostics } = tokenize(
    "// line\n/* block */ let x\n",
    "t.jsv",
  );
  assert.equal(diagnostics.length, 0);
  const kinds = tokens.map((t) => t.kind);
  assert.deepEqual(kinds, ["keyword", "ident", "eof"]);
});

test("unterminated block comment", () => {
  const { diagnostics } = tokenize("/* oops", "t.jsv");
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.unterminated_comment"),
  );
});

test("unterminated string", () => {
  const { diagnostics } = tokenize('"hello', "t.jsv");
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.unterminated_string"),
  );
});

test("invalid escape", () => {
  const { diagnostics } = tokenize('"\\q"', "t.jsv");
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.invalid_escape"),
  );
});

test("invalid number 01", () => {
  const { diagnostics } = tokenize("01", "t.jsv");
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.invalid_number"),
  );
});

test("string decodes escapes", () => {
  const { tokens, diagnostics } = tokenize('"a\\nb\\t"', "t.jsv");
  assert.equal(diagnostics.length, 0);
  assert.equal(tokens[0]?.kind, "string");
  assert.equal(tokens[0]?.value, "a\nb\t");
});

test("template with interpolation", () => {
  const { tokens, diagnostics } = tokenize("`a${1}b`", "t.jsv");
  assert.equal(diagnostics.length, 0);
  const kinds = tokens.map((t) => t.kind);
  assert.deepEqual(kinds, [
    "template_head",
    "number",
    "template_tail",
    "eof",
  ]);
  assert.equal(tokens[0]?.value, "a");
  assert.equal(tokens[2]?.value, "b");
});

test("keywords are not identifiers", () => {
  const { tokens } = tokenize("from as new", "t.jsv");
  assert.ok(tokens.every((t) => t.kind === "keyword" || t.kind === "eof"));
});

test("spans are 1-based inclusive", () => {
  const { tokens } = tokenize("ab", "t.jsv");
  const t = tokens[0]!;
  assert.deepEqual(t.span.start, { line: 1, column: 1 });
  assert.deepEqual(t.span.end, { line: 1, column: 2 });
});
