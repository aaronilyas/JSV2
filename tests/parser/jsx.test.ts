import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../src/parser/parse.ts";
import type { Expr } from "../../src/parser/ast.ts";

function exprOf(source: string): { expr: Expr; diagnostics: { code: string; message: string }[] } {
  const { program, diagnostics } = parse(source, "t.jsv");
  const stmt = program.body[0];
  assert.ok(stmt);
  assert.equal(stmt.kind, "expr_stmt");
  if (stmt.kind !== "expr_stmt") throw new Error("unreachable");
  return { expr: stmt.expression, diagnostics };
}

test("element, text, attributes, and fragment", () => {
  const { expr, diagnostics } = exprOf(
    '<div id="a" class="x" onClick={() => { return 1; }}><span>Hello {name}</span></div>;',
  );
  assert.equal(diagnostics.length, 0);
  assert.equal(expr.kind, "jsx");
  if (expr.kind !== "jsx") return;
  assert.equal(expr.tag, "div");
  assert.deepEqual(
    expr.attributes.map((a) => a.name),
    ["id", "class", "onClick"],
  );
  assert.equal(expr.children.length, 1);
  const span = expr.children[0];
  assert.ok(span && span.kind === "expr" && span.expr.kind === "jsx");
  if (span?.kind !== "expr" || span.expr.kind !== "jsx") return;
  assert.equal(span.expr.tag, "span");
  assert.equal(span.expr.children[0]?.kind, "text");
  if (span.expr.children[0]?.kind === "text") {
    assert.equal(span.expr.children[0].value, "Hello ");
  }
  assert.equal(span.expr.children[1]?.kind, "expr");
});

test("newlines around tags are dropped and a space without a newline is kept", () => {
  const { expr, diagnostics } = exprOf("<p>\n  Hello\n</p>;");
  assert.equal(diagnostics.length, 0);
  if (expr.kind !== "jsx") throw new Error("jsx");
  assert.equal(expr.children.length, 1);
  assert.equal(expr.children[0]?.kind, "text");
  if (expr.children[0]?.kind === "text") {
    assert.equal(expr.children[0].value, "Hello");
  }

  const spaced = exprOf("<p>Hello {name}</p>;");
  if (spaced.expr.kind !== "jsx") throw new Error("jsx");
  assert.equal(spaced.expr.children[0]?.kind, "text");
  if (spaced.expr.children[0]?.kind === "text") {
    assert.equal(spaced.expr.children[0].value, "Hello ");
  }
});

test("JSX comments are omitted and $ is plain text", () => {
  const { expr, diagnostics } = exprOf(
    "<p>\n  {/* note */}\n  price is $5\n</p>;",
  );
  assert.equal(diagnostics.length, 0);
  if (expr.kind !== "jsx") throw new Error("jsx");
  assert.equal(expr.children.length, 1);
  if (expr.children[0]?.kind === "text") {
    assert.equal(expr.children[0].value, "price is $5");
  }
});

test("fragment and each", () => {
  const frag = exprOf("<>{name}</>;");
  assert.equal(frag.diagnostics.length, 0);
  if (frag.expr.kind !== "jsx") throw new Error("jsx");
  assert.equal(frag.expr.tag, null);
  assert.equal(frag.expr.children.length, 1);

  const each = exprOf(
    "<each items={rows} key={(row: Row) => row.id}>{(row: Signal<Row>) => <li />}</each>;",
  );
  assert.equal(each.diagnostics.length, 0, JSON.stringify(each.diagnostics));
  if (each.expr.kind !== "jsx") throw new Error("jsx");
  assert.equal(each.expr.tag, "each");
  assert.equal(each.expr.children.length, 1);
  const child = each.expr.children[0];
  assert.ok(child && child.kind === "expr" && child.expr.kind === "arrow");
});

test("comparison and generic calls are not JSX", () => {
  const cmp = exprOf("a < b;");
  assert.equal(cmp.diagnostics.length, 0);
  assert.equal(cmp.expr.kind, "binary");

  const call = exprOf("id<number>(1);");
  assert.equal(call.diagnostics.length, 0);
  assert.equal(call.expr.kind, "call");

  const nested = exprOf('<a id={a < b ? "x" : "y"} />;');
  assert.equal(nested.diagnostics.length, 0);
  if (nested.expr.kind !== "jsx") throw new Error("jsx");
  assert.equal(nested.expr.attributes[0]?.value.kind, "ternary");
});

test("mismatched and unclosed tags", () => {
  const mismatch = parse("<div></span>;", "t.jsv");
  assert.ok(mismatch.diagnostics.some((d) => d.code === "jsv.parse.jsx_mismatch"));

  const open = parse("<div>", "t.jsv");
  assert.ok(open.diagnostics.some((d) => d.code === "jsv.parse.jsx_unclosed"));
});

test("self-closing void and component tags", () => {
  const { expr, diagnostics } = exprOf("<><br /><Counter /></>;");
  assert.equal(diagnostics.length, 0, JSON.stringify(diagnostics));
  if (expr.kind !== "jsx") throw new Error("jsx");
  assert.equal(expr.tag, null);
  assert.equal(expr.children.length, 2);
  const br = expr.children[0];
  const counter = expr.children[1];
  assert.ok(br && br.kind === "expr" && br.expr.kind === "jsx" && br.expr.tag === "br");
  assert.ok(
    counter &&
      counter.kind === "expr" &&
      counter.expr.kind === "jsx" &&
      counter.expr.tag === "Counter",
  );
});
