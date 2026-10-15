export type Signal<T> = {
  get(): T;
  set(value: T): void;
  update(fn: (value: T) => T): void;
};

export type Computed<T> = {
  get(): T;
};

type DepNode = {
  subscribers: Set<ReactiveNode>;
};

type ReactiveNode = ComputedNode | EffectNode;

type ComputedNode = DepNode & {
  kind: "computed";
  fn: () => unknown;
  value: unknown;
  hasValue: boolean;
  dirty: boolean;
  computing: boolean;
  deps: Set<DepNode>;
};

type EffectNode = {
  kind: "effect";
  fn: () => void | (() => void);
  cleanup: (() => void) | null;
  dirty: boolean;
  disposed: boolean;
  deps: Set<DepNode>;
};

let active: ReactiveNode | null = null;
const effectQueue: EffectNode[] = [];
let flushing = false;

function link(dep: DepNode): void {
  if (active === null) return;
  dep.subscribers.add(active);
  active.deps.add(dep);
}

function clearDeps(node: ReactiveNode): void {
  for (const dep of node.deps) {
    dep.subscribers.delete(node);
  }
  node.deps.clear();
}

function markDirty(node: ReactiveNode): void {
  if (node.kind === "computed") {
    if (node.dirty) return;
    node.dirty = true;
    for (const sub of node.subscribers) {
      markDirty(sub);
    }
  } else {
    if (node.disposed || node.dirty) return;
    node.dirty = true;
    effectQueue.push(node);
  }
}

function notify(dep: DepNode): void {
  // Copy: subscribers may re-subscribe during flush.
  const subs = [...dep.subscribers];
  for (const sub of subs) {
    markDirty(sub);
  }
  flushEffects();
}

function runEffect(effect: EffectNode): void {
  if (effect.disposed) return;
  if (effect.cleanup !== null) {
    const cleanup = effect.cleanup;
    effect.cleanup = null;
    cleanup();
  }
  clearDeps(effect);
  effect.dirty = false;
  const prev = active;
  active = effect;
  try {
    const result = effect.fn();
    if (typeof result === "function") {
      effect.cleanup = result;
    }
  } finally {
    active = prev;
  }
}

function flushEffects(): void {
  if (flushing) return;
  flushing = true;
  try {
    while (effectQueue.length > 0) {
      const effect = effectQueue.shift()!;
      if (effect.disposed || !effect.dirty) continue;
      runEffect(effect);
    }
  } finally {
    flushing = false;
  }
}

function recompute(node: ComputedNode): void {
  if (node.computing) {
    throw new Error("jsv.runtime.cycle: computed depends on itself");
  }
  clearDeps(node);
  node.computing = true;
  node.dirty = false;
  const prev = active;
  active = node;
  try {
    node.value = node.fn();
    node.hasValue = true;
  } finally {
    active = prev;
    node.computing = false;
  }
}

export function signal<T>(initial: T): Signal<T> {
  const node: DepNode & { value: T } = {
    value: initial,
    subscribers: new Set(),
  };

  const api: Signal<T> = {
    get(): T {
      link(node);
      return node.value;
    },
    set(value: T): void {
      if (Object.is(node.value, value)) return;
      node.value = value;
      notify(node);
    },
    update(fn: (value: T) => T): void {
      api.set(fn(api.get()));
    },
  };
  return api;
}

export function computed<T>(fn: () => T): Computed<T> {
  const node: ComputedNode = {
    kind: "computed",
    fn,
    value: undefined,
    hasValue: false,
    dirty: true,
    computing: false,
    deps: new Set(),
    subscribers: new Set(),
  };

  return {
    get(): T {
      link(node);
      if (node.dirty || !node.hasValue) {
        recompute(node);
      }
      return node.value as T;
    },
  };
}

export function effect(fn: () => void | (() => void)): () => void {
  const node: EffectNode = {
    kind: "effect",
    fn,
    cleanup: null,
    dirty: true,
    disposed: false,
    deps: new Set(),
  };

  runEffect(node);

  return () => {
    if (node.disposed) return;
    node.disposed = true;
    node.dirty = false;
    if (node.cleanup !== null) {
      const cleanup = node.cleanup;
      node.cleanup = null;
      cleanup();
    }
    clearDeps(node);
  };
}
