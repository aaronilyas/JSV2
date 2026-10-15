import assert from "node:assert/strict";
import { test } from "node:test";
import { completionsAt } from "../../src/mcp/complete.ts";
import type { SourcePosition } from "../../src/diagnostics.ts";

function at(source: string, needle: string, nth = 0): SourcePosition {
  let from = 0;
  let index = -1;
  for (let i = 0; i <= nth; i++) {
    index = source.indexOf(needle, from);
    assert.ok(index >= 0, `missing ${needle}`);
    from = index + 1;
  }
  let line = 1;
  let column = 1;
  for (let i = 0; i < index; i++) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function namesAt(
  source: string,
  pos: SourcePosition,
): { name: string; kind: string; type: string; optional?: boolean; bindingKind: string }[] {
  const result = completionsAt(source, "t.jsv", pos.line, pos.column);
  return result.candidates;
}

test("complete lists locals, params, imports, and top-level declarations", () => {
  const source = [
    'import { signal } from "jsv/dom";',
    "type Alias = number;",
    "function declared(p: number): number {",
    "  let local: number = p;",
    "  return local;",
    "}",
    "",
  ].join("\n");
  // Column 1 of the `return` line is the indent, after `local` is declared.
  const all = namesAt(source, { line: 5, column: 1 });
  const byName = new Map(all.map((c) => [c.name, c]));
  assert.equal(byName.get("local")?.kind, "local");
  assert.equal(byName.get("local")?.type, "number");
  assert.equal(byName.get("p")?.kind, "param");
  assert.equal(byName.get("p")?.bindingKind, "value");
  assert.equal(byName.get("signal")?.kind, "import");
  assert.match(byName.get("signal")?.type ?? "", /Signal<T>/);
  assert.equal(byName.get("Alias")?.kind, "declaration");
  assert.equal(byName.get("Alias")?.bindingKind, "type");
  assert.equal(byName.get("declared")?.kind, "declaration");
  assert.equal(byName.get("declared")?.type, "(p: number) => number");
  assert.equal(byName.get("console")?.kind, "ambient");

  const prefixed = completionsAt(source, "t.jsv", 5, at(source, "local", 1).column);
  assert.equal(prefixed.prefix, "l");
  assert.deepEqual(
    prefixed.candidates.map((c) => c.name),
    ["local"],
  );
});

test("complete lists signal, computed, object, and class members from the checked type", () => {
  const signal = [
    'import { signal, computed } from "jsv/dom";',
    "let s = signal<number>(0);",
    "let c = computed<number>(() => 1);",
    "s.set;",
    "c.get;",
    "",
  ].join("\n");
  const onDot = namesAt(signal, at(signal, "."));
  assert.deepEqual(
    onDot.map((c) => c.name),
    ["get", "set", "update"],
  );
  assert.equal(onDot.find((c) => c.name === "get")?.type, "() => number");
  assert.equal(
    onDot.find((c) => c.name === "set")?.type,
    "(value: number) => void",
  );
  assert.equal(
    onDot.find((c) => c.name === "update")?.type,
    "(fn: (value: number) => number) => void",
  );

  const setAt = at(signal, "s.set");
  const setOnly = completionsAt(signal, "t.jsv", setAt.line, setAt.column + 3);
  assert.equal(setOnly.prefix, "se");
  assert.deepEqual(
    setOnly.candidates.map((c) => c.name),
    ["set"],
  );

  const computedDot = at(signal, ".", 1);
  assert.deepEqual(
    namesAt(signal, computedDot).map((c) => c.name),
    ["get"],
  );

  const dangling = [
    'import { signal } from "jsv/dom";',
    "let s = signal<number>(0);",
    "s.",
    "",
  ].join("\n");
  const danglingDot = at(dangling, "s.");
  const danglingResult = completionsAt(
    dangling,
    "t.jsv",
    danglingDot.line,
    danglingDot.column + 1,
  );
  assert.deepEqual(
    danglingResult.candidates.map((c) => c.name),
    ["get", "set", "update"],
  );
  assert.equal(danglingResult.prefix, "");

  const obj = 'let o: { a?: number; b: string } = { b: "x" };\no.a;\n';
  const props = namesAt(obj, at(obj, "."));
  assert.equal(props.find((c) => c.name === "a")?.optional, true);
  assert.equal(props.find((c) => c.name === "a")?.type, "number");
  assert.equal(props.find((c) => c.name === "b")?.optional, false);
  assert.equal(props.find((c) => c.name === "b")?.type, "string");

  const cls = [
    "class Box {",
    "  value: number;",
    "  getValue(): number {",
    "    return this.value;",
    "  }",
    "}",
    "let b: Box = new Box();",
    "b.value;",
    "",
  ].join("\n");
  const box = at(cls, "b.value");
  const members = namesAt(cls, { line: box.line, column: box.column + 1 });
  assert.deepEqual(
    members.map((c) => c.name),
    ["getValue", "value"],
  );
  assert.equal(members.find((c) => c.name === "value")?.type, "number");
  assert.equal(members.find((c) => c.name === "getValue")?.type, "() => number");

  const union = [
    'import { signal, computed, Signal, Computed } from "jsv/dom";',
    "let s = signal<number>(0);",
    "let c = computed<number>(() => 1);",
    "let either: Signal<number> | Computed<number> = s;",
    "either.get;",
    "",
  ].join("\n");
  const either = at(union, "either.get");
  assert.deepEqual(
    namesAt(union, {
      line: either.line,
      column: either.column + "either".length,
    }).map((c) => c.name),
    ["get"],
  );

  const num = "let n: number = 1;\nn.foo;\n";
  const none = namesAt(num, at(num, "."));
  assert.deepEqual(none, []);
});

test("complete lists jsv/dom exports inside an import specifier", () => {
  const source = 'import { signal } from "jsv/dom";\n';
  const onName = completionsAt(source, "t.jsv", 1, at(source, "signal").column);
  assert.equal(onName.prefix, "s");
  assert.deepEqual(
    onName.candidates.map((c) => c.name),
    ["signal"],
  );
  assert.equal(onName.candidates[0]!.kind, "module-export");

  const onSpace = completionsAt(source, "t.jsv", 1, at(source, "{").column + 1);
  const exported = onSpace.candidates.map((c) => c.name);
  assert.ok(exported.includes("signal"));
  assert.ok(exported.includes("computed"));
  assert.ok(exported.includes("effect"));
  assert.ok(exported.includes("text"));
  assert.ok(exported.includes("h"));
  assert.ok(exported.includes("fragment"));
  assert.ok(exported.includes("list"));
  assert.ok(exported.includes("Node"));
  assert.ok(exported.includes("Signal"));
  assert.ok(exported.includes("Computed"));
  assert.ok(exported.includes("DomProps"));
  assert.equal(
    onSpace.candidates.find((c) => c.name === "Signal")?.bindingKind,
    "type",
  );
  assert.equal(
    onSpace.candidates.find((c) => c.name === "signal")?.bindingKind,
    "value",
  );

  const aliased = 'import { signal as sig } from "jsv/dom";\n';
  const localName = at(aliased, " as sig");
  const onLocal = completionsAt(
    aliased,
    "t.jsv",
    localName.line,
    localName.column + " as ".length,
  );
  assert.ok(!onLocal.candidates.some((c) => c.kind === "module-export"));

  const other = 'import { signal } from "./other.jsv";\n';
  const otherResult = completionsAt(other, "t.jsv", 1, at(other, "signal").column);
  assert.deepEqual(otherResult.candidates, []);
});
