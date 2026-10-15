import {
  ensureWasm,
  jsvRuntime,
  runtimeBackend,
  throwIfPending,
} from "./wasm-load.ts";

await ensureWasm();

export type Signal<T> = {
  get(): T;
  set(value: T): void;
  update(fn: (value: T) => T): void;
};

export type Computed<T> = {
  get(): T;
};

export { runtimeBackend };

// Wrappers the user no longer holds are released on the Go side. The held
// value is the node id, not the wrapper, so the wrapper itself can be collected.
const releasedNodes = new FinalizationRegistry((id: number) => {
  jsvRuntime().releaseNode(id);
});

export function signal<T>(initial: T): Signal<T> {
  const rt = jsvRuntime();
  const id = rt.signalNew(initial);
  const api: Signal<T> = {
    get(): T {
      return rt.signalGet(id) as T;
    },
    set(value: T): void {
      rt.signalSet(id, value);
      throwIfPending();
    },
    update(fn: (value: T) => T): void {
      api.set(fn(api.get()));
    },
  };
  releasedNodes.register(api, id);
  return api;
}

function throwIfCycle(value: unknown): void {
  if (
    typeof value === "object" &&
    value !== null &&
    "__jsv_cycle__" in value
  ) {
    const msg = String((value as { __jsv_cycle__: unknown }).__jsv_cycle__);
    throw new Error(msg);
  }
}

export function computed<T>(fn: () => T): Computed<T> {
  const rt = jsvRuntime();
  const id = rt.computedNew(fn);
  const api: Computed<T> = {
    get(): T {
      const value = rt.computedGet(id);
      throwIfPending();
      throwIfCycle(value);
      return value as T;
    },
  };
  releasedNodes.register(api, id);
  return api;
}

export function effect(fn: () => void | (() => void)): () => void {
  const rt = jsvRuntime();
  const id = rt.effectNew(fn);
  throwIfPending();
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    rt.effectDispose(id);
    throwIfPending();
  };
}
