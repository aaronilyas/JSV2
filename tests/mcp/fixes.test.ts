import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource } from "../../src/checker/check.ts";
import { suggestFix } from "../../src/mcp/fixes.ts";
import type { SourcePosition } from "../../src/diagnostics.ts";

function applyEdits(
  source: string,
  edits: { start: SourcePosition; end: SourcePosition; newText: string }[],
): string {
  // ASCII-only fixtures; columns are UTF-16 code units.
  function offset(pos: SourcePosition): number {
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
    throw new Error(`position ${pos.line}:${pos.column} out of range`);
  }

  const sorted = [...edits].sort((a, b) => {
    const ao = offset(a.start);
    const bo = offset(b.start);
    return bo - ao;
  });
  let out = source;
  for (const e of sorted) {
    const s = offset(e.start);
    const end = offset(e.end);
    out = out.slice(0, s) + e.newText + out.slice(end);
  }
  return out;
}

test("suggestFix inserts semicolon for unexpected_token expecting ;", () => {
  const source = "let x: number = 1\nlet y: number = 2;\n";
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.parse.unexpected_token",
    2,
    1,
  );
  assert.equal(result.applicable, true);
  assert.equal(result.edits.length, 1);
  assert.equal(result.edits[0]!.newText, ";");

  const fixed = applyEdits(source, result.edits);
  const { diagnostics } = checkSource(fixed, "t.jsv");
  assert.equal(diagnostics.length, 0);
});

test("suggestFix not applicable for const_missing_init", () => {
  const source = "const x: number;";
  const { diagnostics } = checkSource(source, "t.jsv");
  const d = diagnostics.find((x) => x.code === "jsv.parse.const_missing_init");
  assert.ok(d?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.parse.const_missing_init",
    d!.start!.line,
    d!.start!.column,
  );
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
  assert.match(result.message, /not auto-fixable/);
});

test("suggestFix not applicable for not_assignable", () => {
  const source = 'let x: string = 1;';
  const { diagnostics } = checkSource(source, "t.jsv");
  const d = diagnostics.find((x) => x.code === "jsv.check.not_assignable");
  assert.ok(d?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.check.not_assignable",
    d!.start!.line,
    d!.start!.column,
  );
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
});

test("suggestFix not applicable for missing_type_arguments", () => {
  const source = "function id<T>(x: T): T { return x; } id(1);";
  const { diagnostics } = checkSource(source, "t.jsv");
  const d = diagnostics.find(
    (x) => x.code === "jsv.check.missing_type_arguments",
  );
  assert.ok(d?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.check.missing_type_arguments",
    d!.start!.line,
    d!.start!.column,
  );
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
});

test("suggestFix not applicable for unknown code", () => {
  const source = "let x: number = 1;";
  const result = suggestFix(source, "t.jsv", "nope", 1, 1);
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
  assert.match(result.message, /No matching diagnostic|not auto-fixable/);
});
