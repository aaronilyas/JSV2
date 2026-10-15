import assert from "node:assert/strict";
import { test } from "node:test";
import { runtimeBackend } from "../../src/runtime/graph.ts";
import { h, renderToString, text } from "../../src/runtime/dom.ts";
import { ensureWasm } from "../../src/runtime/wasm-load.ts";

test("runtimeBackend is wasm", () => {
  assert.equal(runtimeBackend(), "wasm");
  assert.equal(runtimeBackend(), "wasm");
});

test("ensureWasm resolves twice without re-instantiating", async () => {
  await ensureWasm();
  await ensureWasm();
});

test("renderToString escapes via wasm", () => {
  const tricky = ["<", "&", "a", "m", "p", ";", ">", '"', "'"].join("");
  const html = renderToString(
    h("div", { id: ["a", "&", "b", "<", '"', "x", "'"].join("") }, [
      text(tricky),
    ]),
  );
  assert.equal(
    html,
    '<div id="a&amp;b&lt;&quot;x\'">&lt;&amp;amp;&gt;&quot;\'</div>',
  );
});
