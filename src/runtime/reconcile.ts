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
  const prevByKey = new Map<string, KeyedEntry<T>>();
  for (const entry of prevEntries) {
    prevByKey.set(entry.key, entry);
  }

  const next: ReconcileResult<T>["next"] = [];
  const seen = new Set<string>();

  for (const item of nextItems) {
    const key = keyOf(item);
    seen.add(key);
    const prev = prevByKey.get(key) ?? null;
    next.push({ key, item, prev });
  }

  const removed: KeyedEntry<T>[] = [];
  for (const entry of prevEntries) {
    if (!seen.has(entry.key)) {
      removed.push(entry);
    }
  }

  return { next, removed };
}
