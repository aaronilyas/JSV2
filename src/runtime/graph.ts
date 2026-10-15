import { ensureWasm, jsvRuntime, runtimeBackend } from "./wasm-load.ts";

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

export function signal<T>(initial: T): Signal<T> {
  const rt = jsvRuntime();
  const id = rt.signalNew(initial);
  const api: Signal<T> = {
    get(): T {
      return rt.signalGet(id) as T;
    },
    set(value: T): void {
      rt.signalSet(id, value);
    },
    update(fn: (value: T) => T): void {
      api.set(fn(api.get()));
    },
  };
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
  return {
    get(): T {
      const value = rt.computedGet(id);
      throwIfCycle(value);
      return value as T;
    },
  };
}

export function effect(fn: () => void | (() => void)): () => void {
  const rt = jsvRuntime();
  const id = rt.effectNew(fn);
  return () => {
    rt.effectDispose(id);
  };
}
