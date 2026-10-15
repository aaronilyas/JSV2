import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "../../src/parser/parse.ts";
import { signal } from "../../src/runtime/graph.ts";
import {
  h,
  jsxChild,
  renderToString,
  text,
  type Node,
} from "../../src/runtime/dom.ts";
import { emitProgram } from "../../src/transpile/emit.ts";
import { loadModule } from "../../src/transpile/run.ts";

test("JSX emits h, text, jsxChild, and list", () => {
  const source = `function view(): Node {
  return <div class="a">{label}<each items={rows} key={keyFn}>{(row: Row) => <li />}</each></div>;
}
`;
  const { program, diagnostics } = parse(source, "t.jsv");
  assert.equal(diagnostics.length, 0);
  const code = emitProgram(program, {
    resolveImport: () => ({
      specifier: "jsv-runtime",
      isValue: () => true,
      hasDefault: false,
    }),
  });
  assert.match(code, /import \{[^}]*h as __jsv_h/);
  assert.match(code, /jsxChild as __jsv_jsxChild/);
  assert.match(code, /list as __jsv_list/);
  assert.match(code, /from "jsv-runtime"/);
  assert.match(code, /__jsv_h\("div", \{ className: "a" \}/);
  assert.match(code, /__jsv_jsxChild\(label\)/);
  assert.match(code, /__jsv_list\(rows, keyFn,/);
  assert.match(code, /__jsv_h\("li", \{\}, \[\]\)/);
});

test("jsxChild keeps signals fine-grained and passes nodes through", () => {
  const label = signal("a<b");
  const node = h("p", {}, [jsxChild(label)]);
  assert.equal(renderToString(node), "<p>a&lt;b</p>");
  label.set("c");
  assert.equal(renderToString(node), "<p>c</p>");

  const inner = h("b", {}, [text("x")]);
  assert.equal(jsxChild(inner), inner);
  assert.equal(renderToString(jsxChild([text("a"), text("b")])), "ab");
  assert.equal(renderToString(jsxChild("a<b")), "a&lt;b");
});

test("component JSX passes children and <each> updates a kept row", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv-jsx-"));
  const file = join(dir, "view.jsv");
  writeFileSync(
    file,
    `import { signal, computed, Signal, Node } from "jsv/dom";
type Row = { id: string; label: string; };
function Card(props: { title: string; children: Node[]; }): Node {
  return <section><h1>{props.title}</h1>{props.children}</section>;
}
export let rows = signal<Row[]>([{ id: "a", label: "one" }]);
export function view(): Node {
  return <Card title="Hi">
    <each items={rows} key={(row: Row) => row.id}>
      {(row: Signal<Row>) => {
        let label = computed<string>(() => { return row.get().label; });
        return <p>{label}</p>;
      }}
    </each>
  </Card>;
}
`,
  );
  const { namespace, cleanup } = await loadModule(file);
  try {
    const view = namespace.view as () => Node;
    const rows = namespace.rows as {
      set: (value: { id: string; label: string }[]) => void;
    };
    const first = view();
    assert.equal(
      renderToString(first),
      "<section><h1>Hi</h1><p>one</p></section>",
    );
    rows.set([{ id: "a", label: "two" }]);
    assert.equal(
      renderToString(view()),
      "<section><h1>Hi</h1><p>two</p></section>",
    );
  } finally {
    await cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});
