import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { domAnalyze } from "../../src/mcp/dom-analyze.ts";

test("domAnalyze flags effect self-write and not get-only", () => {
  const selfWrite = `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
effect(() => {
  let n: number = count.get();
  count.set(n + 1);
});
`;
  const bad = domAnalyze(selfWrite, "t.jsv");
  assert.ok(
    bad.issues.some((i) => i.code === "jsv.dom.effect_self_write"),
    JSON.stringify(bad.issues),
  );
  assert.equal(bad.effects.length, 1);
  assert.equal(bad.signals.length, 1);

  const getOnly = `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
effect(() => {
  let n: number = count.get();
  console.log(n);
});
`;
  const ok = domAnalyze(getOnly, "t.jsv");
  assert.ok(!ok.issues.some((i) => i.code === "jsv.dom.effect_self_write"));
});

test("domAnalyze flags conditional signal and not function-body signal", () => {
  const conditional = `import { signal } from "jsv/dom";
function f(): void {
  if (true) {
    signal<number>(1);
  }
}
`;
  const bad = domAnalyze(conditional, "t.jsv");
  assert.ok(
    bad.issues.some((i) => i.code === "jsv.dom.conditional_signal"),
    JSON.stringify(bad.issues),
  );

  const topInFn = `import { signal } from "jsv/dom";
function f(): void {
  signal<number>(1);
}
`;
  const ok = domAnalyze(topInFn, "t.jsv");
  assert.ok(!ok.issues.some((i) => i.code === "jsv.dom.conditional_signal"));
  assert.equal(ok.signals.length, 1);
});

test("domAnalyze flags unused list item and not used", () => {
  const unused = `import { list } from "jsv/dom";
let items: number[] = [];
let key: (x: number) => string = (x: number) => "k";
list(items, key, (item: number) => {
  return 1;
});
`;
  const bad = domAnalyze(unused, "t.jsv");
  assert.ok(
    bad.issues.some((i) => i.code === "jsv.dom.list_unused_item"),
    JSON.stringify(bad.issues),
  );

  const used = `import { list } from "jsv/dom";
let items: number[] = [];
let key: (x: number) => string = (x: number) => "k";
list(items, key, (item: number) => {
  return item;
});
`;
  const ok = domAnalyze(used, "t.jsv");
  assert.ok(!ok.issues.some((i) => i.code === "jsv.dom.list_unused_item"));
});

test("domAnalyze respects import aliases", () => {
  const source = `import { signal as s } from "jsv/dom";
function f(): void {
  if (true) {
    s(1);
  }
}
`;
  const result = domAnalyze(source, "t.jsv");
  assert.ok(
    result.issues.some((i) => i.code === "jsv.dom.conditional_signal"),
    JSON.stringify(result.issues),
  );
  assert.equal(result.signals.length, 1);
});

test("domAnalyze walks partial AST despite parse diagnostics", () => {
  const source = `import { signal } from "jsv/dom";
let s = signal<number>(0)
if (true) {
  signal<number>(1);
}
`;
  const result = domAnalyze(source, "t.jsv");
  assert.equal(result.signals.length, 2);
  assert.ok(
    result.issues.some((i) => i.code === "jsv.dom.conditional_signal"),
    JSON.stringify(result.issues),
  );
  assert.ok(
    result.diagnostics.some((d) => d.code === "jsv.parse.unexpected_token"),
    JSON.stringify(result.diagnostics),
  );
  assert.ok(
    !result.issues.some((i) => i.code.startsWith("jsv.parse.")),
  );
});

test("domAnalyze clean file has empty diagnostics", () => {
  const source = `import { signal } from "jsv/dom";
let s = signal<number>(0);
`;
  const result = domAnalyze(source, "t.jsv");
  assert.equal(result.diagnostics.length, 0);
  assert.equal(result.signals.length, 1);
  assert.equal(result.issues.length, 0);
});

test("dom-analyze.ts does not import WASM runtime modules", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const text = readFileSync(join(root, "src", "mcp", "dom-analyze.ts"), "utf8");
  assert.ok(!text.includes("wasm-load"));
  assert.ok(!text.includes("runtime/graph"));
  assert.ok(!text.includes("runtime/index"));
});
