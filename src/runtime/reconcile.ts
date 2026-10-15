import { ensureWasm, jsvRuntime } from "./wasm-load.ts";

await ensureWasm();

export type KeyedEntry<T> = {
  key: string;
  item: T;
};

export type ReconcileResult<T> = {
  /** Entries kept or created, in new order. `prev` is the prior entry when the key existed. */
  next: Array<{ key: string; item: T; prev: KeyedEntry<T> | null }>;
  /** Prior entries whose keys are absent from the new list. */
  removed: KeyedEntry<T>[];
};

/**
 * Keyed list diff: same key is reused (prev non-null), missing keys are removed,
 * new keys have prev null. Order follows `nextItems`.
 */
export function reconcile<T>(
  prevEntries: readonly KeyedEntry<T>[],
  nextItems: readonly T[],
  keyOf: (item: T) => string,
): ReconcileResult<T> {
  const prevKeys = prevEntries.map((e) => e.key);
  const nextKeys = nextItems.map(keyOf);
  const { reuse, removed: removedIdx } = jsvRuntime().reconcile(
    prevKeys,
    nextKeys,
  );

  const next: ReconcileResult<T>["next"] = [];
  for (let i = 0; i < nextItems.length; i++) {
    const key = nextKeys[i]!;
    const item = nextItems[i]!;
    const prevIdx = reuse[i]!;
    const prev = prevIdx >= 0 ? (prevEntries[prevIdx] ?? null) : null;
    next.push({ key, item, prev });
  }

  const removed: KeyedEntry<T>[] = [];
  for (const idx of removedIdx) {
    removed.push(prevEntries[idx]!);
  }

  return { next, removed };
}
