import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

type GoConstructor = new () => {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
};

function findWasmDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let dir = here;
  for (let i = 0; i < 5; i++) {
    const wasmPath = path.join(dir, "runtime", "wasm", "jsv.wasm");
    if (fs.existsSync(wasmPath)) {
      return path.join(dir, "runtime", "wasm");
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `jsv.wasm not found (searched up from ${here} for runtime/wasm/jsv.wasm); run make wasm`,
  );
}

/** Load the WASM runtime from disk. Used by Node (backend and tests). */
export async function loadNodeWasm(): Promise<void> {
  const wasmDir = findWasmDir();
  const execSource = fs.readFileSync(path.join(wasmDir, "wasm_exec.js"), "utf8");
  vm.runInThisContext(execSource, { filename: "wasm_exec.js" });

  const Go = (globalThis as { Go?: GoConstructor }).Go;
  if (Go === undefined) {
    throw new Error("globalThis.Go was not set by wasm_exec.js");
  }

  const ready = new Promise<void>((resolve) => {
    (globalThis as { __jsvWasmReady?: () => void }).__jsvWasmReady = () => {
      resolve();
    };
  });

  const go = new Go();
  const wasmBytes = fs.readFileSync(path.join(wasmDir, "jsv.wasm"));
  const result = await WebAssembly.instantiate(wasmBytes, go.importObject);
  // Do not await: go.run resolves only when the Go program exits.
  void go.run(result.instance);
  await ready;
}
