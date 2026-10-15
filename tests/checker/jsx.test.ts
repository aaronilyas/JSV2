import assert from "node:assert/strict";
import { test } from "node:test";
import { checkSource, typeAt } from "../../src/checker/check.ts";

function codes(source: string): string[] {
  return checkSource(source, "t.jsv").diagnostics.map((d) => d.code);
}

const header = `import { signal, computed, Signal, Node } from "jsv/dom";
`;

test("button with a string signal typechecks as Node", () => {
  const source = `${header}
let label = signal<string>("a");
function view(): Node {
  return <button class="x" onClick={() => { label.set("b"); }}>{label}</button>;
}
`;
  assert.deepEqual(codes(source), []);
  const lines = source.split("\n");
  const line = lines.findIndex((l) => l.includes("<button")) + 1;
  const column = (lines[line - 1] ?? "").indexOf("<") + 1;
  const hit = typeAt(source, "t.jsv", line, column);
  assert.equal(hit.hit?.type, "Node");
});

test("number child, unknown attribute, and void children", () => {
  const source = `${header}
let n = signal<number>(1);
function view(): Node {
  return <div onclick={n}>{n}<br>x</br></div>;
}
`;
  const found = codes(source);
  assert.ok(found.includes("jsv.check.jsx_attribute"), found.join(","));
  assert.ok(found.includes("jsv.check.jsx_child"), found.join(","));
  assert.ok(found.includes("jsv.check.jsx_void_children"), found.join(","));
});

test("<each> infers T and requires Signal<T> in the render callback", () => {
  const ok = `${header}
type Row = { id: string; label: string; };
let rows = signal<Row[]>([{ id: "a", label: "one" }]);
function view(): Node {
  return <each items={rows} key={(row: Row) => row.id}>
    {(row: Signal<Row>) => <li>{row.get().label}</li>}
  </each>;
}
`;
  assert.deepEqual(codes(ok), [], codes(ok).join(","));

  const bad = `${header}
type Row = { id: string; label: string; };
let rows = signal<Row[]>([{ id: "a", label: "one" }]);
function view(): Node {
  return <each items={rows} key={(row: Row) => row.id}>
    {(row: Row) => <li />}
  </each>;
}
`;
  assert.ok(codes(bad).includes("jsv.check.not_assignable"));
});

test("component props and children", () => {
  const source = `${header}
function Card(props: { title: string; children: Node[]; }): Node {
  return <section><h1>{props.title}</h1>{props.children}</section>;
}
function view(): Node {
  return <Card title="Hi"><p>there</p></Card>;
}
function bare(): Node {
  return <Card />;
}
`;
  const found = codes(source);
  assert.ok(found.includes("jsv.check.jsx_component"), found.join(","));
  assert.equal(found.filter((c) => c !== "jsv.check.jsx_component").length, 0);
});

test("zero-arg component rejects props", () => {
  const source = `${header}
function Counter(): Node {
  return <span>n</span>;
}
function view(): Node {
  return <div><Counter /></div>;
}
function bad(): Node {
  return <Counter id="x" />;
}
`;
  assert.deepEqual(codes(source), ["jsv.check.jsx_component"]);
});

test("class and className together are one attribute", () => {
  const source = `${header}
function view(): Node {
  return <p class="a" className="b" />;
}
`;
  assert.ok(codes(source).includes("jsv.check.jsx_attribute"));
});
