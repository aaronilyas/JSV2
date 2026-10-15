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

test("suggestFix inserts inferred type arguments on a generic call", () => {
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
  assert.equal(result.applicable, true);
  assert.equal(result.edits[0]!.newText, "<number>");
  const fixed = applyEdits(source, result.edits);
  assert.equal(
    fixed,
    "function id<T>(x: T): T { return x; } id<number>(1);",
  );
  assert.equal(checkSource(fixed, "t.jsv").diagnostics.length, 0);
});

test("suggestFix inserts inferred type arguments for jsv/dom signal", () => {
  const source = `import { signal } from "jsv/dom";
signal(1);
`;
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
  assert.equal(result.applicable, true);
  assert.equal(result.edits[0]!.newText, "<number>");
  const fixed = applyEdits(source, result.edits);
  assert.match(fixed, /signal<number>\(1\)/);
  assert.equal(checkSource(fixed, "t.jsv").diagnostics.length, 0);
});

test("suggestFix inserts inferred type arguments on a generic annotation", () => {
  const source =
    "interface Box<T> { value: T; } let b: Box = { value: 1 };";
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
  assert.equal(result.applicable, true);
  assert.equal(result.edits[0]!.newText, "<number>");
  const fixed = applyEdits(source, result.edits);
  assert.match(fixed, /Box<number>/);
  assert.equal(checkSource(fixed, "t.jsv").diagnostics.length, 0);
});

test("suggestFix does not infer conflicting or unconstrained type arguments", () => {
  const conflict =
    'function pair<T>(a: T, b: T): T { return a; } pair(1, "a");';
  const conflictDiag = checkSource(conflict, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.missing_type_arguments",
  );
  assert.ok(conflictDiag?.start);
  const conflictFix = suggestFix(
    conflict,
    "t.jsv",
    "jsv.check.missing_type_arguments",
    conflictDiag!.start!.line,
    conflictDiag!.start!.column,
  );
  assert.equal(conflictFix.applicable, false);
  assert.equal(conflictFix.edits.length, 0);

  const free = "function f<T>(): void { return; } f();";
  const freeDiag = checkSource(free, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.missing_type_arguments",
  );
  assert.ok(freeDiag?.start);
  const freeFix = suggestFix(
    free,
    "t.jsv",
    "jsv.check.missing_type_arguments",
    freeDiag!.start!.line,
    freeDiag!.start!.column,
  );
  assert.equal(freeFix.applicable, false);
  assert.equal(freeFix.edits.length, 0);
});

test("suggestFix renames a uniquely close in-scope identifier", () => {
  const source = "let count: number = 1;\ncout;\n";
  const { diagnostics } = checkSource(source, "t.jsv");
  const d = diagnostics.find((x) => x.code === "jsv.check.unresolved_name");
  assert.ok(d?.start && d.end);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.check.unresolved_name",
    d!.start!.line,
    d!.start!.column,
  );
  assert.equal(result.applicable, true);
  assert.equal(result.edits[0]!.newText, "count");
  const fixed = applyEdits(source, result.edits);
  assert.equal(checkSource(fixed, "t.jsv").diagnostics.length, 0);

  const transposed = "let count: number = 1;\nconut;\n";
  const td = checkSource(transposed, "t.jsv").diagnostics.find(
    (x) => x.code === "jsv.check.unresolved_name",
  );
  assert.ok(td?.start);
  const tr = suggestFix(
    transposed,
    "t.jsv",
    "jsv.check.unresolved_name",
    td!.start!.line,
    td!.start!.column,
  );
  assert.equal(tr.applicable, true);
  assert.equal(tr.edits[0]!.newText, "count");
});

test("suggestFix corrects a type name and a primitive typo", () => {
  const alias = 'type User = { name: string; }; let x: Usr = { name: "a" };';
  const aliasDiag = checkSource(alias, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.unresolved_name",
  );
  assert.ok(aliasDiag?.start);
  const aliasFix = suggestFix(
    alias,
    "t.jsv",
    "jsv.check.unresolved_name",
    aliasDiag!.start!.line,
    aliasDiag!.start!.column,
  );
  assert.equal(aliasFix.applicable, true);
  assert.equal(aliasFix.edits[0]!.newText, "User");
  assert.equal(
    checkSource(applyEdits(alias, aliasFix.edits), "t.jsv").diagnostics.length,
    0,
  );

  const prim = "let x: nmber = 1;";
  const primDiag = checkSource(prim, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.unresolved_name",
  );
  assert.ok(primDiag?.start);
  const primFix = suggestFix(
    prim,
    "t.jsv",
    "jsv.check.unresolved_name",
    primDiag!.start!.line,
    primDiag!.start!.column,
  );
  assert.equal(primFix.applicable, true);
  assert.equal(primFix.edits[0]!.newText, "number");
  assert.equal(
    checkSource(applyEdits(prim, primFix.edits), "t.jsv").diagnostics.length,
    0,
  );
});

test("suggestFix refuses ambiguous or distant identifier typos", () => {
  const tied = "let ab: number = 1; let cb: number = 2; b;";
  const tiedDiag = checkSource(tied, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.unresolved_name",
  );
  assert.ok(tiedDiag?.start);
  const tiedFix = suggestFix(
    tied,
    "t.jsv",
    "jsv.check.unresolved_name",
    tiedDiag!.start!.line,
    tiedDiag!.start!.column,
  );
  assert.equal(tiedFix.applicable, false);

  const far = "let count: number = 1; ct;";
  const farDiag = checkSource(far, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.unresolved_name",
  );
  assert.ok(farDiag?.start);
  const farFix = suggestFix(
    far,
    "t.jsv",
    "jsv.check.unresolved_name",
    farDiag!.start!.line,
    farDiag!.start!.column,
  );
  assert.equal(farFix.applicable, false);
});

test("suggestFix imports a known jsv/dom export", () => {
  const fresh = "effect(() => { return; });\n";
  const freshDiag = checkSource(fresh, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.unresolved_name",
  );
  assert.ok(freshDiag?.start);
  const freshFix = suggestFix(
    fresh,
    "t.jsv",
    "jsv.check.unresolved_name",
    freshDiag!.start!.line,
    freshDiag!.start!.column,
  );
  assert.equal(freshFix.applicable, true);
  assert.equal(
    freshFix.edits[0]!.newText,
    'import { effect } from "jsv/dom";\n',
  );
  assert.equal(
    checkSource(applyEdits(fresh, freshFix.edits), "t.jsv").diagnostics.length,
    0,
  );

  const existing = `import { effect } from "jsv/dom";
text("hi");
`;
  const existingDiag = checkSource(existing, "t.jsv").diagnostics.find(
    (d) => d.code === "jsv.check.unresolved_name",
  );
  assert.ok(existingDiag?.start);
  const existingFix = suggestFix(
    existing,
    "t.jsv",
    "jsv.check.unresolved_name",
    existingDiag!.start!.line,
    existingDiag!.start!.column,
  );
  assert.equal(existingFix.applicable, true);
  assert.equal(existingFix.edits[0]!.newText, ", text");
  const merged = applyEdits(existing, existingFix.edits);
  assert.match(merged, /import \{ effect, text \} from "jsv\/dom"/);
  assert.equal(checkSource(merged, "t.jsv").diagnostics.length, 0);
});

test("suggestFix imports a jsv/dom type export", () => {
  const source = "function f(x: Signal<number>): void { return; }\n";
  const d = checkSource(source, "t.jsv").diagnostics.find(
    (x) => x.code === "jsv.check.unresolved_name",
  );
  assert.ok(d?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.check.unresolved_name",
    d!.start!.line,
    d!.start!.column,
  );
  assert.equal(result.applicable, true);
  assert.match(result.edits[0]!.newText, /import \{ Signal \} from "jsv\/dom"/);
  assert.equal(
    checkSource(applyEdits(source, result.edits), "t.jsv").diagnostics.length,
    0,
  );
});

test("suggestFix does not guess when a typo and a jsv/dom export both match", () => {
  const source = "let signals: number = 1;\nsignal;\n";
  const d = checkSource(source, "t.jsv").diagnostics.find(
    (x) => x.code === "jsv.check.unresolved_name",
  );
  assert.ok(d?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.check.unresolved_name",
    d!.start!.line,
    d!.start!.column,
  );
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
  assert.match(result.message, /Multiple possible fixes/);
});

test("suggestFix not applicable for unknown code", () => {
  const source = "let x: number = 1;";
  const result = suggestFix(source, "t.jsv", "nope", 1, 1);
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
  assert.match(result.message, /No matching diagnostic|not auto-fixable/);
});
