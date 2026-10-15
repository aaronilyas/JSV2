import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource } from "../../src/checker/check.ts";
import type { Diagnostic } from "../../src/diagnostics.ts";

function hasCode(diags: readonly Diagnostic[], code: string): boolean {
  return diags.some((d) => d.code === code);
}

test("Counter program typechecks with jsv/dom", () => {
  const source = `
import { signal, computed, h, text, Node } from "jsv/dom";

function Counter(): Node {
  const count = signal<number>(0);
  const label = computed<string>(() => "n=" + count.get());
  return h("button", {
    onClick: () => { count.set(count.get() + 1); },
  }, [text(label)]);
}
`;
  const { diagnostics } = checkSource(source, "counter.jsv");
  assert.deepEqual(
    diagnostics,
    [],
    diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
  );
});

test("missing export from jsv/dom", () => {
  const { diagnostics } = checkSource(
    'import { missing } from "jsv/dom";',
    "t.jsv",
  );
  assert.ok(hasCode(diagnostics, "jsv.check.missing_export"));
});

test("bare react specifier is module_not_found", () => {
  const { diagnostics } = checkSource(
    'import { signal } from "react";',
    "t.jsv",
  );
  assert.ok(hasCode(diagnostics, "jsv.check.module_not_found"));
});

test("Node type export cannot be used as a value", () => {
  const { diagnostics } = checkSource(
    'import { Node } from "jsv/dom"; let x = Node;',
    "t.jsv",
  );
  assert.ok(hasCode(diagnostics, "jsv.check.type_as_value"));
});
