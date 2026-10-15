import assert from "node:assert/strict";
import { test } from "node:test";
import { computed, effect, signal } from "../../src/runtime/graph.ts";

test("signal get/set and Object.is skips notify", () => {
  const s = signal(1);
  assert.equal(s.get(), 1);
  let runs = 0;
  effect(() => {
    s.get();
    runs += 1;
  });
  assert.equal(runs, 1);
  s.set(1);
  assert.equal(runs, 1);
  s.set(2);
  assert.equal(runs, 2);
  s.update((n) => n + 1);
  assert.equal(s.get(), 3);
  assert.equal(runs, 3);
});

test("computed is lazy and caches", () => {
  const s = signal(1);
  let computes = 0;
  const c = computed(() => {
    computes += 1;
    return s.get() * 2;
  });
  assert.equal(computes, 0);
  assert.equal(c.get(), 2);
  assert.equal(computes, 1);
  assert.equal(c.get(), 2);
  assert.equal(computes, 1);
  s.set(3);
  assert.equal(computes, 1);
  assert.equal(c.get(), 6);
  assert.equal(computes, 2);
});

test("computed invalidates through effect", () => {
  const s = signal(1);
  const c = computed(() => s.get() + 10);
  const seen: number[] = [];
  effect(() => {
    seen.push(c.get());
  });
  assert.deepEqual(seen, [11]);
  s.set(2);
  assert.deepEqual(seen, [11, 12]);
});

test("effect dispose unsubscribes", () => {
  const s = signal(0);
  let runs = 0;
  const dispose = effect(() => {
    s.get();
    runs += 1;
  });
  assert.equal(runs, 1);
  dispose();
  s.set(1);
  assert.equal(runs, 1);
});

test("effect cleanup runs before next run and on dispose", () => {
  const s = signal(0);
  const cleanups: string[] = [];
  const dispose = effect(() => {
    const v = s.get();
    return () => {
      cleanups.push(`c${v}`);
    };
  });
  assert.deepEqual(cleanups, []);
  s.set(1);
  assert.deepEqual(cleanups, ["c0"]);
  s.set(2);
  assert.deepEqual(cleanups, ["c0", "c1"]);
  dispose();
  assert.deepEqual(cleanups, ["c0", "c1", "c2"]);
});

test("set flushes dirty effects synchronously", () => {
  const a = signal(0);
  const b = signal(0);
  const order: string[] = [];
  effect(() => {
    order.push(`a=${a.get()}`);
    if (a.get() === 1) b.set(1);
  });
  effect(() => {
    order.push(`b=${b.get()}`);
  });
  order.length = 0;
  a.set(1);
  assert.deepEqual(order, ["a=1", "b=1"]);
});

test("cycle throws jsv.runtime.cycle", () => {
  const c: { get(): number } = computed(() => c.get());
  assert.throws(
    () => c.get(),
    (err: unknown) =>
      err instanceof Error && err.message.includes("jsv.runtime.cycle"),
  );
});

test("dynamic dependencies resubscribe each run", () => {
  const cond = signal(true);
  const a = signal(1);
  const b = signal(10);
  let runs = 0;
  effect(() => {
    runs += 1;
    if (cond.get()) a.get();
    else b.get();
  });
  assert.equal(runs, 1);
  b.set(11);
  assert.equal(runs, 1);
  a.set(2);
  assert.equal(runs, 2);
  cond.set(false);
  assert.equal(runs, 3);
  a.set(3);
  assert.equal(runs, 3);
  b.set(12);
  assert.equal(runs, 4);
});
