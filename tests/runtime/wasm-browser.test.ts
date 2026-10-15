import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

test("browser wasm loader runs without node built-ins", () => {
  const browserPath = fileURLToPath(
    new URL("../../src/runtime/wasm-browser.ts", import.meta.url),
  );
  const raw = readFileSync(browserPath, "utf8");
  assert.equal(
    /\bnode:|readFileSync|createRequire|from ["']fs["']|require\(/.test(raw),
    false,
  );

  const sandbox = fileURLToPath(
    new URL("./browser-loader-sandbox.mjs", import.meta.url),
  );
  const res = spawnSync(
    process.execPath,
    ["--experimental-vm-modules", sandbox],
    { encoding: "utf8", cwd: root },
  );
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
});
