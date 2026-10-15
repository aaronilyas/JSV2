import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFile } from "../../src/checker/check.ts";
import {
  mount,
  renderToString,
  type MountNode,
  type MountParent,
  type Node,
} from "../../src/runtime/dom.ts";
import { loadModule, runFile } from "../../src/transpile/run.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cliPath = join(root, "src", "cli.ts");
const helloPath = join(root, "examples", "hello.jsv");
const counterPath = join(root, "examples", "counter.jsv");
const todosPath = join(root, "examples", "todos.jsv");

type FakeEl = MountNode & {
  tag: string;
  attrs: Map<string, string>;
  listeners: Map<string, Set<(ev: { currentTarget: MountNode }) => void>>;
  _children: FakeEl[];
  _parent: FakeParent | null;
};

type FakeParent = MountParent & {
  _children: FakeEl[];
};

function createFakeParent(): FakeParent {
  const parent: FakeParent = {
    _children: [],
    appendChild(child: MountNode) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = parent;
      parent._children.push(c);
      if (!c.childNodes) c.childNodes = c._children;
    },
    removeChild(child: MountNode) {
      const c = child as FakeEl;
      const i = parent._children.indexOf(c);
      if (i >= 0) parent._children.splice(i, 1);
      c._parent = null;
    },
    insertBefore(child: MountNode, before: MountNode | null) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = parent;
      if (before === null) {
        parent._children.push(c);
      } else {
        const i = parent._children.indexOf(before as FakeEl);
        if (i < 0) parent._children.push(c);
        else parent._children.splice(i, 0, c);
      }
      if (!c.childNodes) c.childNodes = c._children;
    },
  };
  return parent;
}

function createElement(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    nodeType: 1,
    textContent: "",
    attrs: new Map(),
    listeners: new Map(),
    value: "",
    parentNode: null,
    _children: [],
    _parent: null,
    get childNodes() {
      return el._children;
    },
    setAttribute(name: string, value: string) {
      el.attrs.set(name, value);
    },
    removeAttribute(name: string) {
      el.attrs.delete(name);
    },
    addEventListener(type, handler) {
      let set = el.listeners.get(type);
      if (!set) {
        set = new Set();
        el.listeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener(type, handler) {
      el.listeners.get(type)?.delete(handler);
    },
    appendChild(child: MountNode) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = el as unknown as FakeParent;
      c.parentNode = el as unknown as MountParent;
      el._children.push(c);
    },
    removeChild(child: MountNode) {
      const c = child as FakeEl;
      const i = el._children.indexOf(c);
      if (i >= 0) el._children.splice(i, 1);
      c._parent = null;
      c.parentNode = null;
    },
    insertBefore(child: MountNode, before: MountNode | null) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = el as unknown as FakeParent;
      c.parentNode = el as unknown as MountParent;
      if (before === null) {
        el._children.push(c);
      } else {
        const i = el._children.indexOf(before as FakeEl);
        if (i < 0) el._children.push(c);
        else el._children.splice(i, 0, c);
      }
    },
  };
  Object.defineProperty(el, "parentNode", {
    get() {
      return el._parent;
    },
    set(v: FakeParent | null) {
      el._parent = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, "textContent", {
    get() {
      return (el as { _text?: string })._text ?? "";
    },
    set(v: string) {
      (el as { _text?: string })._text = v;
    },
    configurable: true,
  });
  return el;
}

function createText(value: string): FakeEl {
  const el = createElement("#text");
  el.nodeType = 3;
  el.textContent = value;
  return el;
}

test("hello.jsv, counter.jsv, and todos.jsv typecheck clean", () => {
  assert.equal(checkFile(helloPath).diagnostics.length, 0);
  assert.equal(checkFile(counterPath).diagnostics.length, 0);
  assert.deepEqual(checkFile(todosPath).diagnostics, []);
});

test("jsv run examples/hello.jsv prints Ada then Bea", () => {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cliPath, "run", helloPath],
    {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "<p>Ada</p>\n<p>Bea</p>\n");
});

test("loadModule Counter mounts and updates in place", async () => {
  const { namespace, cleanup } = await loadModule(counterPath);
  try {
    const Counter = namespace.Counter as () => Node;
    assert.equal(typeof Counter, "function");
    const parent = createFakeParent();
    mount(parent, Counter(), createElement, createText);
    const btn = parent._children.find((c) => c.tag === "button");
    assert.ok(btn);
    const textNode = btn!._children.find((c) => c.nodeType === 3);
    assert.ok(textNode);
    assert.equal(textNode!.textContent, "count 0");

    const handlers = btn!.listeners.get("click");
    assert.ok(handlers && handlers.size === 1);
    for (const hnd of handlers!) hnd({ currentTarget: btn! });

    assert.equal(textNode!.textContent, "count 1");
    assert.equal(parent._children.find((c) => c.tag === "button"), btn);
  } finally {
    await cleanup();
  }
});

test("loadModule TodoList renders rows", async () => {
  const { namespace, cleanup } = await loadModule(todosPath);
  try {
    const TodoList = namespace.TodoList as () => Node;
    assert.equal(renderToString(TodoList()), "<ul><li>one</li><li>two</li></ul>");
    const parent = createFakeParent();
    mount(parent, TodoList(), createElement, createText);
    const ul = parent._children.find((c) => c.tag === "ul");
    assert.ok(ul);
    const labels = () =>
      ul!._children
        .filter((c) => c.tag === "li")
        .map((li) => li._children.find((c) => c.nodeType === 3)?.textContent);
    assert.deepEqual(labels(), ["one", "two"]);
  } finally {
    await cleanup();
  }
});

test("mounted each updates the text node for a kept key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv-each-"));
  const file = join(dir, "rows.jsv");
  writeFileSync(
    file,
    `import { signal, computed, Signal, Node } from "jsv/dom";
type Row = { id: string; label: string; };
export let rows = signal<Row[]>([{ id: "a", label: "one" }]);
export function view(): Node {
  return <ul>
    <each items={rows} key={(row: Row) => row.id}>
      {(row: Signal<Row>) => {
        let label = computed<string>(() => { return row.get().label; });
        return <li>{label}</li>;
      }}
    </each>
  </ul>;
}
`,
  );
  const { namespace, cleanup } = await loadModule(file);
  try {
    const view = namespace.view as () => Node;
    const rows = namespace.rows as {
      set: (next: { id: string; label: string }[]) => void;
    };
    const parent = createFakeParent();
    mount(parent, view(), createElement, createText);
    const ul = parent._children.find((c) => c.tag === "ul");
    assert.ok(ul);
    const textOf = () =>
      ul!._children
        .find((c) => c.tag === "li")
        ?._children.find((c) => c.nodeType === 3)?.textContent;
    assert.equal(textOf(), "one");
    rows.set([{ id: "a", label: "two" }]);
    assert.equal(textOf(), "two");
  } finally {
    await cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFile prints value across two modules", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv-ex-"));
  const logs: unknown[] = [];
  const originalLog = console.log;
  try {
    writeFileSync(join(dir, "a.jsv"), "export let n: number = 42;\n");
    writeFileSync(
      join(dir, "b.jsv"),
      'import { n } from "./a.jsv";\nconsole.log(n);\n',
    );
    console.log = (...args: unknown[]) => {
      logs.push(...args);
    };
    const code = await runFile(join(dir, "b.jsv"));
    assert.equal(code, 0);
    assert.deepEqual(logs, [42]);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runFile on computed cycle exits 1 with jsv.runtime.cycle on stderr", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv-ex-"));
  const originalErr = process.stderr.write;
  let errOut = "";
  try {
    writeFileSync(
      join(dir, "cycle.jsv"),
      `import { computed } from "jsv/dom";
let c = computed<number>(() => { return 1; });
c = computed<number>(() => { return c.get(); });
console.log(c.get());
`,
    );
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errOut += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }) as typeof process.stderr.write;
    const code = await runFile(join(dir, "cycle.jsv"));
    assert.equal(code, 1);
    assert.match(errOut, /jsv\.runtime\.cycle/);
  } finally {
    process.stderr.write = originalErr;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("emitted class runs and prints 3", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv-ex-"));
  const logs: unknown[] = [];
  const originalLog = console.log;
  try {
    writeFileSync(
      join(dir, "box.jsv"),
      `class Box {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  get(): number {
    return this.value;
  }
}
let b = new Box(3);
console.log(b.get());
`,
    );
    console.log = (...args: unknown[]) => {
      logs.push(...args);
    };
    const code = await runFile(join(dir, "box.jsv"));
    assert.equal(code, 0);
    assert.deepEqual(logs, [3]);
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function runLogged(
  source: string,
): Promise<{ code: number; logs: unknown[] }> {
  const dir = mkdtempSync(join(tmpdir(), "jsv-ex-"));
  const logs: unknown[] = [];
  const originalLog = console.log;
  try {
    const file = join(dir, "t.jsv");
    writeFileSync(file, source);
    console.log = (...args: unknown[]) => {
      logs.push(...args);
    };
    const code = await runFile(file);
    return { code, logs };
  } finally {
    console.log = originalLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("unary minus does not collapse into decrement", async () => {
  const a = await runLogged(
    "let x: number = - -1;\nconsole.log(x);\n",
  );
  assert.equal(a.code, 0);
  assert.deepEqual(a.logs, [1]);

  const b = await runLogged(
    "let x: number = -(-2);\nconsole.log(x);\n",
  );
  assert.equal(b.code, 0);
  assert.deepEqual(b.logs, [2]);
});

test("bare let under if is parent-scoped", async () => {
  const r = await runLogged(
    "if (true) let x: number = 1;\nconsole.log(x);\n",
  );
  assert.equal(r.code, 0);
  assert.deepEqual(r.logs, [1]);
});

test("bare let under if/else is parent-scoped", async () => {
  const r = await runLogged(
    "if (false) let x: number = 1; else let y: number = 2;\nconsole.log(y);\n",
  );
  assert.equal(r.code, 0);
  assert.deepEqual(r.logs, [2]);
});

test("let inside block stays block-scoped", async () => {
  const r = await runLogged(
    "if (true) { let x: number = 1; console.log(x); }\n",
  );
  assert.equal(r.code, 0);
  assert.deepEqual(r.logs, [1]);
});

test("bare let under while does not throw", async () => {
  const r = await runLogged(
    "let n: number = 0; while (n < 0) let extra: number = 1; console.log(n);\n",
  );
  assert.equal(r.code, 0);
  assert.deepEqual(r.logs, [0]);
});

test("bare function under if is wrapped and runs", async () => {
  const r = await runLogged(
    "if (true) function f(): number { return 3; }\n",
  );
  assert.equal(r.code, 0);
});
