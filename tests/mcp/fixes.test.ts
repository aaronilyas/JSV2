import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource } from "../../src/checker/check.ts";
import { domAnalyze } from "../../src/mcp/dom-analyze.ts";
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

function fixAt(
  source: string,
  code: string,
): { applicable: boolean; edits: { start: SourcePosition; end: SourcePosition; newText: string }[]; message: string } {
  const diagnostic = checkSource(source, "t.jsv").diagnostics.find((item) => item.code === code);
  assert.ok(diagnostic?.start, source);
  return suggestFix(source, "t.jsv", code, diagnostic.start.line, diagnostic.start.column);
}

test("suggestFix reads a signal or computed with .get()", () => {
  const source = `import { signal, computed } from "jsv/dom";
let count = signal<number>(0);
let label = computed<string>(() => { return "n"; });
let n: number = count;
let s: string = label;
`;
  const countFix = fixAt(source, "jsv.check.not_assignable");
  assert.equal(countFix.applicable, true);
  assert.equal(countFix.edits[0]!.newText, ".get()");
  const once = applyEdits(source, countFix.edits);
  const labelDiag = checkSource(once, "t.jsv").diagnostics.find(
    (item) => item.code === "jsv.check.not_assignable",
  );
  assert.ok(labelDiag?.start);
  const labelFix = suggestFix(
    once,
    "t.jsv",
    "jsv.check.not_assignable",
    labelDiag.start.line,
    labelDiag.start.column,
  );
  assert.equal(labelFix.edits[0]!.newText, ".get()");
  assert.equal(checkSource(applyEdits(once, labelFix.edits), "t.jsv").diagnostics.length, 0);

  const mismatch = `import { signal } from "jsv/dom";
let count = signal<number>(0);
let s: string = count;
`;
  assert.equal(fixAt(mismatch, "jsv.check.not_assignable").applicable, false);
});

test("suggestFix calls .get and wraps signal operands", () => {
  const forgotten = `import { signal } from "jsv/dom";
let count = signal<number>(0);
let n: number = count.get;
`;
  const call = fixAt(forgotten, "jsv.check.not_assignable");
  assert.equal(call.applicable, true);
  assert.equal(call.edits[0]!.newText, "()");
  assert.equal(checkSource(applyEdits(forgotten, call.edits), "t.jsv").diagnostics.length, 0);

  const added = `import { signal } from "jsv/dom";
let count = signal<number>(0);
let n: number = count + 1;
`;
  const op = fixAt(added, "jsv.check.bad_operator");
  assert.equal(op.applicable, true);
  assert.equal(op.edits[0]!.newText, ".get()");
  assert.match(applyEdits(added, op.edits), /count\.get\(\) \+ 1/);
  assert.equal(checkSource(applyEdits(added, op.edits), "t.jsv").diagnostics.length, 0);

  const flag = `import { signal } from "jsv/dom";
let flag = signal<boolean>(true);
if (flag) { let x: number = 1; }
`;
  const cond = fixAt(flag, "jsv.check.condition_not_boolean");
  assert.equal(cond.applicable, true);
  assert.match(applyEdits(flag, cond.edits), /if \(flag\.get\(\)\)/);

  const numberFlag = `import { signal } from "jsv/dom";
let count = signal<number>(0);
if (count) { let x: number = 1; }
`;
  assert.equal(fixAt(numberFlag, "jsv.check.condition_not_boolean").applicable, false);
});

test("suggestFix casts unknown and converts unambiguous literals", () => {
  const unknown = `let u: unknown = 1;
let s: string = u;
`;
  const cast = fixAt(unknown, "jsv.check.not_assignable");
  assert.equal(cast.applicable, true);
  assert.equal(cast.edits[0]!.newText, "u as string");
  assert.equal(checkSource(applyEdits(unknown, cast.edits), "t.jsv").diagnostics.length, 0);

  const textCall = `import { text } from "jsv/dom";
text(1);
`;
  const literal = fixAt(textCall, "jsv.check.not_assignable");
  assert.equal(literal.applicable, true);
  assert.equal(literal.edits[0]!.newText, '"1"');
  assert.equal(checkSource(applyEdits(textCall, literal.edits), "t.jsv").diagnostics.length, 0);

  const numeric = `function takes(x: number): void { return; }
takes("1");
`;
  const num = fixAt(numeric, "jsv.check.not_assignable");
  assert.equal(num.edits[0]!.newText, "1");
  assert.equal(checkSource(applyEdits(numeric, num.edits), "t.jsv").diagnostics.length, 0);

  const padded = `function takes(x: number): void { return; }
takes("01");
`;
  assert.equal(fixAt(padded, "jsv.check.not_assignable").applicable, false);
});

test("suggestFix writes a signal with set and relaxes a plain const", () => {
  const signal = `import { signal } from "jsv/dom";
const count = signal<number>(0);
count = 1;
`;
  const set = fixAt(signal, "jsv.check.assign_const");
  assert.equal(set.applicable, true);
  assert.equal(set.edits[0]!.newText, "count.set(1)");
  assert.equal(checkSource(applyEdits(signal, set.edits), "t.jsv").diagnostics.length, 0);

  const plain = `const n: number = 1;
n = 2;
`;
  const letFix = fixAt(plain, "jsv.check.assign_const");
  assert.equal(letFix.applicable, true);
  assert.equal(letFix.edits[0]!.newText, "let");
  assert.equal(checkSource(applyEdits(plain, letFix.edits), "t.jsv").diagnostics.length, 0);

  const wrong = `const n: number = 1;
n = "a";
`;
  assert.equal(fixAt(wrong, "jsv.check.assign_const").applicable, false);
});

test("suggestFix renames a uniquely close property", () => {
  const source = `import { signal } from "jsv/dom";
let count = signal<number>(0);
count.st(1);
`;
  const result = fixAt(source, "jsv.check.missing_property");
  assert.equal(result.applicable, true);
  assert.equal(result.edits[0]!.newText, "set");
  assert.equal(checkSource(applyEdits(source, result.edits), "t.jsv").diagnostics.length, 0);

  const tied = `let o: { a: number; b: number; } = { a: 1, b: 2 };
o.c;
`;
  assert.equal(fixAt(tied, "jsv.check.missing_property").applicable, false);
});

test("suggestFix inserts return and a required return type", () => {
  const missing = `function f(): number { 1; }
`;
  const ret = fixAt(missing, "jsv.check.missing_return");
  assert.equal(ret.applicable, true);
  assert.equal(ret.edits[0]!.newText, "return ");
  assert.match(applyEdits(missing, ret.edits), /return 1;/);
  assert.equal(checkSource(applyEdits(missing, ret.edits), "t.jsv").diagnostics.length, 0);

  const busy = `function f(): number {
  let x: number = 1;
  x;
}
`;
  assert.equal(fixAt(busy, "jsv.check.missing_return").applicable, false);

  const untyped = `function f() { return 1; }
`;
  const diag = checkSource(untyped, "t.jsv").diagnostics.find(
    (item) => item.message === "function return type is required",
  );
  assert.ok(diag?.start);
  const typed = suggestFix(
    untyped,
    "t.jsv",
    "jsv.parse.unexpected_token",
    diag.start.line,
    diag.start.column,
  );
  assert.equal(typed.applicable, true);
  assert.equal(typed.edits[0]!.newText, ": number ");
  assert.equal(checkSource(applyEdits(untyped, typed.edits), "t.jsv").diagnostics.length, 0);

  const empty = `function f() { }
`;
  const emptyDiag = checkSource(empty, "t.jsv").diagnostics.find(
    (item) => item.message === "function return type is required",
  );
  assert.ok(emptyDiag?.start);
  const voidFix = suggestFix(
    empty,
    "t.jsv",
    "jsv.parse.unexpected_token",
    emptyDiag.start.line,
    emptyDiag.start.column,
  );
  assert.equal(voidFix.edits[0]!.newText, ": void ");

  const conflict = `function f() { return 1; return "a"; }
`;
  const conflictDiag = checkSource(conflict, "t.jsv").diagnostics.find(
    (item) => item.message === "function return type is required",
  );
  assert.ok(conflictDiag?.start);
  assert.equal(
    suggestFix(
      conflict,
      "t.jsv",
      "jsv.parse.unexpected_token",
      conflictDiag.start.line,
      conflictDiag.start.column,
    ).applicable,
    false,
  );
});

test("suggestFix removes unexpected type arguments", () => {
  const source = `function id(x: number): number { return x; }
id<number>(1);
`;
  const result = fixAt(source, "jsv.check.unexpected_type_arguments");
  assert.equal(result.applicable, true);
  assert.equal(result.edits[0]!.newText, "");
  assert.match(applyEdits(source, result.edits), /id\(1\)/);
  assert.equal(checkSource(applyEdits(source, result.edits), "t.jsv").diagnostics.length, 0);
});

test("suggestFix does not insert a semicolon in the middle of a declaration", () => {
  const source = "let x number = 1;";
  const diag = checkSource(source, "t.jsv").diagnostics.find(
    (item) => item.code === "jsv.parse.unexpected_token",
  );
  assert.ok(diag?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.parse.unexpected_token",
    diag.start.line,
    diag.start.column,
  );
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
});

test("suggestFix imports a mistyped jsv/dom name when it is unique", () => {
  const source = "signl<number>(0);\n";
  const result = fixAt(source, "jsv.check.unresolved_name");
  assert.equal(result.applicable, true);
  const fixed = applyEdits(source, result.edits);
  assert.match(fixed, /import \{ signal \} from "jsv\/dom"/);
  assert.match(fixed, /signal<number>\(0\)/);
  assert.equal(checkSource(fixed, "t.jsv").diagnostics.length, 0);

  const tied = "let signa: number = 1;\nsignl;\n";
  assert.equal(fixAt(tied, "jsv.check.unresolved_name").applicable, false);
});

test("suggestFix turns a pure deriving effect into computed", () => {
  const source = `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
let doubled = signal<number>(0);
effect(() => {
  doubled.set(count.get() * 2);
});
`;
  const analyzed = checkSource(source, "t.jsv");
  assert.equal(analyzed.diagnostics.length, 0);
  const issue = domAnalyze(source, "t.jsv").issues.find(
    (item: { code: string; start?: SourcePosition }) =>
      item.code === "jsv.dom.effect_should_be_computed",
  );
  assert.ok(issue?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.dom.effect_should_be_computed",
    issue.start.line,
    issue.start.column,
  );
  assert.equal(result.applicable, true);
  const fixed = applyEdits(source, result.edits);
  assert.match(fixed, /computed<number>\(\(\) => \{ return count\.get\(\) \* 2; \}\)/);
  assert.equal(fixed.includes("doubled.set"), false);
  assert.equal(checkSource(fixed, "t.jsv").diagnostics.length, 0);

  const otherWrite = `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
let doubled = signal<number>(0);
effect(() => {
  doubled.set(count.get() * 2);
});
doubled.set(1);
`;
  const other = domAnalyze(otherWrite, "t.jsv").issues.find(
    (item: { code: string; start?: SourcePosition }) =>
      item.code === "jsv.dom.effect_should_be_computed",
  );
  assert.ok(other?.start);
  assert.equal(
    suggestFix(
      otherWrite,
      "t.jsv",
      "jsv.dom.effect_should_be_computed",
      other.start.line,
      other.start.column,
    ).applicable,
    false,
  );

  const untyped = `import { signal, effect } from "jsv/dom";
let count = signal(0);
let doubled = signal(0);
effect(() => {
  doubled.set(count.get() * 2);
});
`;
  const untypedIssue = domAnalyze(untyped, "t.jsv").issues.find(
    (item) => item.code === "jsv.dom.effect_should_be_computed",
  );
  assert.ok(untypedIssue?.start);
  assert.equal(
    suggestFix(
      untyped,
      "t.jsv",
      "jsv.dom.effect_should_be_computed",
      untypedIssue.start.line,
      untypedIssue.start.column,
    ).applicable,
    false,
  );
});

test("suggestFix leaves other DOM warnings unedited", () => {
  const source = `import { signal } from "jsv/dom";
function f(): void {
  if (true) {
    signal<number>(1);
  }
}
`;
  const issue = domAnalyze(source, "t.jsv").issues.find(
    (item) => item.code === "jsv.dom.conditional_signal",
  );
  assert.ok(issue?.start);
  const result = suggestFix(
    source,
    "t.jsv",
    "jsv.dom.conditional_signal",
    issue.start.line,
    issue.start.column,
  );
  assert.equal(result.applicable, false);
  assert.equal(result.edits.length, 0);
});
