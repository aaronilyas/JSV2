import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { computed, effect, signal } from "../../src/runtime/graph.ts";
import { nodeStats } from "../../src/runtime/wasm-load.ts";

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

test("effects on one signal run in subscription order", () => {
  for (let trial = 0; trial < 25; trial++) {
    const s = signal(0);
    const order: number[] = [];
    const stops: Array<() => void> = [];
    for (let i = 0; i < 8; i++) {
      const n = i;
      stops.push(
        effect(() => {
          order.push(n);
          s.get();
        }),
      );
    }
    order.length = 0;
    s.set(trial + 1);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
    for (const stop of stops) stop();
  }
});

test("effect order stays stable across updates", () => {
  const s = signal(0);
  const order: number[] = [];
  const stops: Array<() => void> = [];
  for (let i = 0; i < 5; i++) {
    const n = i;
    stops.push(
      effect(() => {
        order.push(n);
        s.get();
      }),
    );
  }
  for (let k = 1; k <= 10; k++) {
    order.length = 0;
    s.set(k);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  }
  for (const stop of stops) stop();
});

test("computed fan-out preserves subscription order", () => {
  for (let trial = 0; trial < 15; trial++) {
    const s = signal(0);
    const c1 = computed(() => s.get() + 1);
    const c2 = computed(() => s.get() + 2);
    const order: string[] = [];
    const stops = [
      effect(() => {
        order.push(`e1:${c1.get()}`);
      }),
      effect(() => {
        order.push(`e2:${c2.get()}`);
      }),
      effect(() => {
        order.push(`e3:${s.get()}`);
      }),
    ];
    order.length = 0;
    s.set(1);
    assert.deepEqual(order, ["e1:2", "e2:3", "e3:1"]);
    for (const stop of stops) stop();
  }
});

test("a thrown effect propagates and later updates still run", () => {
  const boom = new Error("effect-boom");
  const s = signal(0);
  effect(() => {
    if (s.get() === 1) throw boom;
  });
  assert.throws(() => s.set(1), (err: unknown) => err === boom);

  const other = signal(10);
  const seen: number[] = [];
  effect(() => {
    seen.push(other.get());
  });
  other.set(11);
  assert.deepEqual(seen, [10, 11]);

  s.set(2);
  assert.equal(s.get(), 2);
});

test("a thrown effect leaves the rest of the queue runnable", () => {
  const s = signal(0);
  const order: string[] = [];
  effect(() => {
    order.push(`a${s.get()}`);
    if (s.get() === 1) throw new Error("a");
  });
  effect(() => {
    order.push(`b${s.get()}`);
  });
  order.length = 0;
  assert.throws(
    () => s.set(1),
    (err: unknown) => err instanceof Error && err.message === "a",
  );
  assert.deepEqual(order, ["a1"]);
  s.set(2);
  assert.deepEqual(order, ["a1", "b2", "a2"]);
});

test("a thrown computed propagates and later updates still run", () => {
  const boom = new Error("computed-boom");
  const s = signal(1);
  const c = computed(() => {
    const v = s.get();
    if (v === 1) throw boom;
    return v * 10;
  });
  assert.throws(() => c.get(), (err: unknown) => err === boom);
  s.set(2);
  assert.equal(c.get(), 20);

  const seen: number[] = [];
  effect(() => {
    seen.push(c.get());
  });
  assert.deepEqual(seen, [20]);
  s.set(3);
  assert.deepEqual(seen, [20, 30]);
});

test("an effect that reads a throwing computed does not kill later updates", () => {
  const s = signal(0);
  const c = computed(() => {
    if (s.get() === 1) throw new Error("inner");
    return s.get();
  });
  const seen: number[] = [];
  effect(() => {
    seen.push(c.get());
  });
  assert.deepEqual(seen, [0]);
  assert.throws(
    () => s.set(1),
    (err: unknown) => err instanceof Error && err.message === "inner",
  );
  s.set(2);
  assert.deepEqual(seen, [0, 2]);
});

test("a thrown effect restores the active reader", () => {
  const s = signal(0);
  assert.throws(() => {
    effect(() => {
      s.get();
      throw new Error("active");
    });
  }, /active/);
  const t = signal(0);
  let runs = 0;
  const c = computed(() => {
    runs += 1;
    return t.get();
  });
  assert.equal(c.get(), 0);
  assert.equal(runs, 1);
  t.set(1);
  assert.equal(runs, 1);
  assert.equal(c.get(), 1);
  assert.equal(runs, 2);
});

test("a thrown cleanup propagates and other signals still update", () => {
  const s = signal(0);
  effect(() => {
    s.get();
    return () => {
      throw new Error("cleanup-boom");
    };
  });
  assert.throws(
    () => s.set(1),
    (err: unknown) => err instanceof Error && err.message === "cleanup-boom",
  );
  const other = signal(0);
  let seen = 0;
  effect(() => {
    seen = other.get();
  });
  other.set(3);
  assert.equal(seen, 3);
  s.set(2);
  assert.equal(s.get(), 2);
});

test("creating a throwing effect does not kill later updates", () => {
  const boom = new Error("init-boom");
  assert.throws(
    () => {
      effect(() => {
        throw boom;
      });
    },
    (err: unknown) => err === boom,
  );
  const s = signal(1);
  let seen = 0;
  effect(() => {
    seen = s.get();
  });
  s.set(4);
  assert.equal(seen, 4);
});

test("dispose releases effect nodes and later effects reuse slots", () => {
  const before = nodeStats();
  const s = signal(0);
  const afterSignal = nodeStats();
  assert.equal(afterSignal.live, before.live + 1);

  const stops: Array<() => void> = [];
  for (let i = 0; i < 30; i++) {
    stops.push(
      effect(() => {
        s.get();
      }),
    );
  }
  const peak = nodeStats();
  assert.equal(peak.live, afterSignal.live + 30);

  for (const stop of stops) stop();
  const freed = nodeStats();
  assert.equal(freed.live, afterSignal.live);
  assert.ok(freed.free >= before.free + 30);

  for (let i = 0; i < 30; i++) {
    const stop = effect(() => {
      s.get();
    });
    stop();
  }
  const reused = nodeStats();
  assert.equal(reused.live, afterSignal.live);
  assert.ok(reused.capacity <= peak.capacity);

  let runs = 0;
  const stop = effect(() => {
    s.get();
    runs += 1;
  });
  s.set(1);
  assert.equal(runs, 2);
  stop();
  s.set(2);
  assert.equal(runs, 2);
});

test("unreferenced signal wrappers are released after gc", () => {
  const res = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      `
      import { signal } from "./src/runtime/graph.ts";
      import { nodeStats } from "./src/runtime/wasm-load.ts";

      const before = nodeStats().live;
      function alloc(n) {
        for (let i = 0; i < n; i++) signal(i);
      }
      alloc(30);
      const mid = nodeStats().live;
      if (mid !== before + 30) {
        console.error("alloc live", mid, "before", before);
        process.exit(1);
      }
      let after = nodeStats().live;
      for (let i = 0; i < 8 && after !== before; i++) {
        globalThis.gc();
        await new Promise((resolve) => setImmediate(resolve));
        after = nodeStats().live;
      }
      if (after !== before) {
        console.error("live", after, "expected", before);
        process.exit(1);
      }
      const s = signal(5);
      if (s.get() !== 5) process.exit(1);
      `,
    ],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
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
