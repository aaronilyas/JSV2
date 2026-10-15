import assert from "node:assert/strict";
import { test } from "node:test";
import { typeAt } from "../../src/checker/check.ts";

test("typeAt on identifier use and type annotation", () => {
  const source = "let count: number = 1; count;";
  const useStart = source.lastIndexOf("count") + 1;
  const use = typeAt(source, "t.jsv", 1, useStart);
  assert.ok(use.hit !== null);
  assert.equal(use.hit!.type, "number");

  const annStart = source.indexOf("number") + 1;
  const ann = typeAt(source, "t.jsv", 1, annStart);
  assert.ok(ann.hit !== null);
  assert.equal(ann.hit!.type, "number");
});

test("typeAt on member, property, and call", () => {
  const source = `import { signal } from "jsv/dom";
let s = signal<number>(1);
s.get();
`;
  // Line 3: s.get();
  // s at col 1, get at cols 3-5, call spans 1-7
  const onS = typeAt(source, "t.jsv", 3, 1);
  assert.ok(onS.hit !== null);
  assert.ok(typeof onS.hit!.type === "string" && onS.hit!.type.length > 0);

  const onGet = typeAt(source, "t.jsv", 3, 4);
  assert.ok(onGet.hit !== null);
  assert.ok(typeof onGet.hit!.type === "string" && onGet.hit!.type.length > 0);

  // Tightest under `get` should differ from under `s` (member/call vs ident).
  assert.notDeepEqual(
    { start: onS.hit!.start, end: onS.hit!.end },
    { start: onGet.hit!.start, end: onGet.hit!.end },
  );

  const onCall = typeAt(source, "t.jsv", 3, 6); // '(' or ')' area still in call
  assert.ok(onCall.hit !== null);
  assert.equal(onCall.hit!.type, "number");
});

test("typeAt returns hit despite other errors; null on uncovered position", () => {
  const source = 'let bad: string = 1; let ok: number = 2; ok;\n';
  const okUse = source.lastIndexOf("ok") + 1;
  const hit = typeAt(source, "t.jsv", 1, okUse);
  assert.ok(hit.hit !== null);
  assert.equal(hit.hit!.type, "number");
  assert.ok(hit.diagnostics.some((d) => d.code === "jsv.check.not_assignable"));

  const past = typeAt(source, "t.jsv", 2, 1);
  assert.equal(past.hit, null);
});
