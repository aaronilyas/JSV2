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

function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } })
    .process;
  return typeof proc?.versions?.node === "string";
}

let loadPromise: Promise<void> | null = null;

function getRuntime(): JsvRuntime {
  const rt = (globalThis as { jsvRuntime?: JsvRuntime }).jsvRuntime;
  if (rt === undefined) {
    throw new Error("jsvRuntime is not registered; call ensureWasm() first");
  }
  return rt;
}

/**
 * Load the single WASM instance for this process (Node) or page (browser).
 * Node reads the module from disk. Browsers fetch it. A second call reuses
 * the in-flight or finished load and does not instantiate again.
 */
export function ensureWasm(): Promise<void> {
  if (loadPromise !== null) return loadPromise;
  loadPromise = loadRuntime().catch((err: unknown) => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

async function loadRuntime(): Promise<void> {
  if (isNodeRuntime()) {
    const { loadNodeWasm } = await import("./wasm-load-node.ts");
    await loadNodeWasm();
    return;
  }
  const { loadBrowserWasm } = await import("./wasm-browser.ts");
  await loadBrowserWasm();
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
