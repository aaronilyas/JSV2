import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

export type NodeStats = {
  live: number;
  capacity: number;
  free: number;
};

export type PendingResult = {
  threw: boolean;
  error: unknown;
};

export type JsvRuntime = {
  backend(): string;
  signalNew(initial: unknown): number;
  signalGet(id: number): unknown;
  signalSet(id: number, value: unknown): void;
  computedNew(fn: () => unknown): number;
  computedGet(id: number): unknown;
  effectNew(fn: () => unknown): number;
  effectDispose(id: number): void;
  releaseNode(id: number): void;
  nodeStats(): NodeStats;
  takePending(): PendingResult;
  reconcile(
    prev: string[],
    next: string[],
  ): { reuse: number[]; removed: number[] };
  escapeXml(s: string): string;
};

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

let loadPromise: Promise<void> | null = null;

function getRuntime(): JsvRuntime {
  const rt = (globalThis as { jsvRuntime?: JsvRuntime }).jsvRuntime;
  if (rt === undefined) {
    throw new Error("jsvRuntime is not registered; call ensureWasm() first");
  }
  return rt;
}

export function ensureWasm(): Promise<void> {
  if (loadPromise !== null) return loadPromise;
  loadPromise = (async () => {
    const wasmDir = findWasmDir();
    const execSource = fs.readFileSync(
      path.join(wasmDir, "wasm_exec.js"),
      "utf8",
    );
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
  })().catch((err: unknown) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

export function jsvRuntime(): JsvRuntime {
  return getRuntime();
}

export function runtimeBackend(): "wasm" {
  return getRuntime().backend() as "wasm";
}

export function nodeStats(): NodeStats {
  return getRuntime().nodeStats();
}

/** Rethrow a user callback error captured by the WASM graph, if any. */
export function throwIfPending(): void {
  const pending = getRuntime().takePending();
  if (pending.threw) {
    throw pending.error;
  }
}
