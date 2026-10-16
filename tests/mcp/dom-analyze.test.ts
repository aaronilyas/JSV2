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

test("domAnalyze flags a list with a missing or constant key", () => {
  const missing = `import { list } from "jsv/dom";
let items: number[] = [];
list(items, (item: number) => item);
`;
  const missingResult = domAnalyze(missing, "t.jsv");
  assert.ok(
    missingResult.issues.some((issue) => issue.code === "jsv.dom.list_missing_key"),
    JSON.stringify(missingResult.issues),
  );

  const constant = `import { list } from "jsv/dom";
let items: number[] = [];
list(items, (item: number) => "k", (item: number) => item);
`;
  const constantResult = domAnalyze(constant, "t.jsv");
  assert.ok(
    constantResult.issues.some(
      (issue) =>
        issue.code === "jsv.dom.list_constant_key" &&
        issue.message.includes("'item'"),
    ),
    JSON.stringify(constantResult.issues),
  );
  assert.ok(
    !constantResult.issues.some((issue) => issue.code === "jsv.dom.list_unused_item"),
  );

  const noParam = `import { list } from "jsv/dom";
let items: number[] = [];
list(items, () => "k", (item: number) => item);
`;
  assert.ok(
    domAnalyze(noParam, "t.jsv").issues.some(
      (issue) =>
        issue.code === "jsv.dom.list_constant_key" &&
        issue.message.includes("does not use its item"),
    ),
  );

  const textKey = `import { list } from "jsv/dom";
let items: number[] = [];
list(items, "id", (item: number) => item);
`;
  assert.ok(
    domAnalyze(textKey, "t.jsv").issues.some(
      (issue) =>
        issue.code === "jsv.dom.list_constant_key" &&
        issue.message.includes("constant string"),
    ),
  );

  const used = `import { list } from "jsv/dom";
let items: number[] = [];
list(items, (item: number) => \`\${item}\`, (item: number) => item);
`;
  const usedResult = domAnalyze(used, "t.jsv");
  assert.ok(!usedResult.issues.some((issue) => issue.code === "jsv.dom.list_constant_key"));
  assert.ok(!usedResult.issues.some((issue) => issue.code === "jsv.dom.list_unused_item"));
});

test("domAnalyze flags a pure deriving effect and a signal created inside one", () => {
  const derived = `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
let doubled = signal<number>(0);
effect(() => {
  doubled.set(count.get() * 2);
});
`;
  const derivedResult = domAnalyze(derived, "t.jsv");
  assert.ok(
    derivedResult.issues.some((issue) => issue.code === "jsv.dom.effect_should_be_computed"),
    JSON.stringify(derivedResult.issues),
  );
  assert.ok(
    !derivedResult.issues.some((issue) => issue.code === "jsv.dom.effect_self_write"),
  );

  const selfWrite = `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
effect(() => {
  count.set(count.get() + 1);
});
`;
  const selfResult = domAnalyze(selfWrite, "t.jsv");
  assert.ok(selfResult.issues.some((issue) => issue.code === "jsv.dom.effect_self_write"));
  assert.ok(
    !selfResult.issues.some((issue) => issue.code === "jsv.dom.effect_should_be_computed"),
  );

  const logged = `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
let doubled = signal<number>(0);
effect(() => {
  doubled.set(count.get() * 2);
  console.log(count.get());
});
`;
  assert.ok(
    !domAnalyze(logged, "t.jsv").issues.some(
      (issue) => issue.code === "jsv.dom.effect_should_be_computed",
    ),
  );

  const created = `import { signal, effect } from "jsv/dom";
effect(() => {
  signal<number>(1);
});
`;
  assert.ok(
    domAnalyze(created, "t.jsv").issues.some(
      (issue) => issue.code === "jsv.dom.signal_in_effect",
    ),
  );

  const nested = `import { signal, effect } from "jsv/dom";
effect(() => {
  let later = () => {
    signal<number>(1);
  };
  function inner(): void {
    signal<number>(2);
  }
});
`;
  assert.ok(
    !domAnalyze(nested, "t.jsv").issues.some(
      (issue) => issue.code === "jsv.dom.signal_in_effect",
    ),
  );

  const insideIf = `import { signal, effect } from "jsv/dom";
effect(() => {
  if (true) {
    signal<number>(1);
  }
});
`;
  const both = domAnalyze(insideIf, "t.jsv");
  assert.ok(both.issues.some((issue) => issue.code === "jsv.dom.signal_in_effect"));
  assert.ok(both.issues.some((issue) => issue.code === "jsv.dom.conditional_signal"));
});

test("domAnalyze flags writes inside computed and ignores arrows nested in if", () => {
  const writes = `import { signal, computed } from "jsv/dom";
let count = signal<number>(0);
computed<number>(() => {
  count.set(1);
  return 0;
});
`;
  assert.ok(
    domAnalyze(writes, "t.jsv").issues.some(
      (issue) =>
        issue.code === "jsv.dom.computed_writes" && issue.message.includes("'count'"),
    ),
  );

  const nested = `import { signal } from "jsv/dom";
function f(): void {
  if (true) {
    let later = () => {
      signal<number>(1);
    };
  }
}
`;
  const result = domAnalyze(nested, "t.jsv");
  assert.equal(result.signals.length, 1);
  assert.ok(!result.issues.some((issue) => issue.code === "jsv.dom.conditional_signal"));
});

test("dom-analyze.ts does not import WASM runtime modules", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const text = readFileSync(join(root, "src", "mcp", "dom-analyze.ts"), "utf8");
  assert.ok(!text.includes("wasm-load"));
  assert.ok(!text.includes("runtime/graph"));
  assert.ok(!text.includes("runtime/index"));
});
