import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "../../src/parser/parse.ts";
import type {
  BinaryOp,
  Expr,
  Statement,
  TypeNode,
} from "../../src/parser/ast.ts";

function exprStmt(body: Statement[]): Expr {
  const s = body[0];
  assert.ok(s);
  assert.equal(s.kind, "expr_stmt");
  if (s.kind !== "expr_stmt") throw new Error("unreachable");
  return s.expression;
}

test("comments and empty program produce zero diagnostics", () => {
  const { program, diagnostics } = parse("// hi\n/* block */\n", "t.jsv");
  assert.equal(diagnostics.length, 0);
  assert.equal(program.kind, "program");
  assert.equal(program.body.length, 0);
});

test("unterminated string, comment, invalid escape, invalid number", () => {
  const a = parse('"x', "t.jsv");
  assert.ok(a.diagnostics.some((d) => d.code === "jsv.parse.unterminated_string"));

  const b = parse("/*", "t.jsv");
  assert.ok(b.diagnostics.some((d) => d.code === "jsv.parse.unterminated_comment"));

  const c = parse('"\\q";', "t.jsv");
  assert.ok(c.diagnostics.some((d) => d.code === "jsv.parse.invalid_escape"));

  const d = parse("01;", "t.jsv");
  assert.ok(d.diagnostics.some((d) => d.code === "jsv.parse.invalid_number"));
});

test("let and const including const without init", () => {
  const letOk = parse("let x;", "t.jsv");
  assert.equal(letOk.diagnostics.length, 0);
  assert.equal(letOk.program.body[0]?.kind, "var");

  const letTyped = parse("let x: number;", "t.jsv");
  assert.equal(letTyped.diagnostics.length, 0);

  const c = parse("const y;", "t.jsv");
  assert.ok(
    c.diagnostics.some((d) => d.code === "jsv.parse.const_missing_init"),
  );
  assert.equal(c.program.body[0]?.kind, "var");

  const cInit = parse("const z = 1;", "t.jsv");
  assert.equal(cInit.diagnostics.length, 0);
});

test("precedence: + vs *; || vs &&; assignment right-assoc", () => {
  const add = exprStmt(parse("1 + 2 * 3;", "t.jsv").program.body);
  assert.equal(add.kind, "binary");
  if (add.kind !== "binary") throw new Error("unreachable");
  assert.equal(add.op, "+");
  assert.equal(add.right.kind, "binary");
  if (add.right.kind === "binary") {
    assert.equal(add.right.op, "*");
  }

  const logic = exprStmt(parse("a || b && c;", "t.jsv").program.body);
  assert.equal(logic.kind, "binary");
  if (logic.kind !== "binary") throw new Error("unreachable");
  assert.equal(logic.op, "||");
  assert.equal(logic.right.kind, "binary");
  if (logic.right.kind === "binary") {
    assert.equal(logic.right.op, "&&");
  }

  const assign = exprStmt(parse("a = b = 1;", "t.jsv").program.body);
  assert.equal(assign.kind, "assign");
  if (assign.kind !== "assign") throw new Error("unreachable");
  assert.equal(assign.value.kind, "assign");
});

test("!x as boolean is unary of assert", () => {
  const e = exprStmt(parse("!x as boolean;", "t.jsv").program.body);
  assert.equal(e.kind, "unary");
  if (e.kind !== "unary") throw new Error("unreachable");
  assert.equal(e.op, "!");
  assert.equal(e.argument.kind, "assert");
});

test("call, member, index, new with type args", () => {
  const call = exprStmt(parse("foo(1, 2);", "t.jsv").program.body);
  assert.equal(call.kind, "call");

  const member = exprStmt(parse("obj.x;", "t.jsv").program.body);
  assert.equal(member.kind, "member");
  if (member.kind === "member") {
    assert.equal(member.property, "x");
  }

  const index = exprStmt(parse("arr[0];", "t.jsv").program.body);
  assert.equal(index.kind, "index");

  const neu = exprStmt(parse("new Foo<number>(1);", "t.jsv").program.body);
  assert.equal(neu.kind, "new");
  if (neu.kind === "new") {
    assert.equal(neu.typeArgs.length, 1);
    assert.equal(neu.args.length, 1);
  }
});

test("generic call vs comparison", () => {
  const generic = exprStmt(parse("id<number>(1);", "t.jsv").program.body);
  assert.equal(generic.kind, "call");
  if (generic.kind === "call") {
    assert.equal(generic.typeArgs.length, 1);
    assert.equal(generic.typeArgs[0]?.kind, "prim");
  }

  const cmp = exprStmt(parse("a < b;", "t.jsv").program.body);
  assert.equal(cmp.kind, "binary");
  if (cmp.kind === "binary") {
    assert.equal(cmp.op, "<" as BinaryOp);
  }
});

test("arrow with expr and block body", () => {
  const a = exprStmt(parse("(x: number) => x + 1;", "t.jsv").program.body);
  assert.equal(a.kind, "arrow");
  if (a.kind === "arrow") {
    assert.equal(a.params.length, 1);
    assert.equal(a.params[0]?.name, "x");
    assert.equal(a.body.kind, "binary");
  }

  const b = exprStmt(
    parse("(x: number) => { return x; };", "t.jsv").program.body,
  );
  assert.equal(b.kind, "arrow");
  if (b.kind === "arrow") {
    assert.equal(b.body.kind, "block");
  }
});

test("object shorthand and array trailing comma", () => {
  // `{` at statement start is a block; parenthesize the object literal.
  const obj = exprStmt(parse("({ a, b: 1 });", "t.jsv").program.body);
  assert.equal(obj.kind, "object");
  if (obj.kind === "object") {
    assert.equal(obj.properties.length, 2);
    assert.equal(obj.properties[0]?.shorthand, true);
    assert.equal(obj.properties[1]?.shorthand, false);
  }

  const arr = exprStmt(parse("[1, 2,];", "t.jsv").program.body);
  assert.equal(arr.kind, "array");
  if (arr.kind === "array") {
    assert.equal(arr.elements.length, 2);
  }
});

test("template parts", () => {
  const t = exprStmt(parse("`a${1 + 2}b`;", "t.jsv").program.body);
  assert.equal(t.kind, "template");
  if (t.kind === "template") {
    assert.equal(t.parts.length, 3);
    assert.equal(t.parts[0]?.kind, "text");
    if (t.parts[0]?.kind === "text") assert.equal(t.parts[0].value, "a");
    assert.equal(t.parts[1]?.kind, "expr");
    if (t.parts[1]?.kind === "expr") {
      assert.equal(t.parts[1].expr.kind, "binary");
    }
    assert.equal(t.parts[2]?.kind, "text");
    if (t.parts[2]?.kind === "text") assert.equal(t.parts[2].value, "b");
  }
});

test("imports and export default function", () => {
  const i1 = parse('import Local from "mod";', "t.jsv");
  assert.equal(i1.diagnostics.length, 0);
  assert.equal(i1.program.body[0]?.kind, "import");
  if (i1.program.body[0]?.kind === "import") {
    assert.equal(i1.program.body[0].defaultName, "Local");
    assert.equal(i1.program.body[0].names.length, 0);
  }

  const i2 = parse('import { a, b as c } from "mod";', "t.jsv");
  assert.equal(i2.diagnostics.length, 0);
  if (i2.program.body[0]?.kind === "import") {
    assert.equal(i2.program.body[0].names.length, 2);
    assert.equal(i2.program.body[0].names[1]?.local, "c");
  }

  const i3 = parse('import Local, { a } from "mod";', "t.jsv");
  assert.equal(i3.diagnostics.length, 0);
  if (i3.program.body[0]?.kind === "import") {
    assert.equal(i3.program.body[0].defaultName, "Local");
    assert.equal(i3.program.body[0].names.length, 1);
  }

  const ex = parse(
    "export default function f(): void {}",
    "t.jsv",
  );
  assert.equal(ex.diagnostics.length, 0);
  assert.equal(ex.program.body[0]?.kind, "function");
  if (ex.program.body[0]?.kind === "function") {
    assert.equal(ex.program.body[0].exported, true);
    assert.equal(ex.program.body[0].defaultExport, true);
  }
});

test("type alias, interface, class", () => {
  const ta = parse("type T = string | number[];", "t.jsv");
  assert.equal(ta.diagnostics.length, 0);
  assert.equal(ta.program.body[0]?.kind, "type_alias");
  if (ta.program.body[0]?.kind === "type_alias") {
    const t: TypeNode = ta.program.body[0].type;
    assert.equal(t.kind, "union");
  }

  const iface = parse(
    "interface I { x?: number; m(a: string): void; }",
    "t.jsv",
  );
  assert.equal(iface.diagnostics.length, 0);
  if (iface.program.body[0]?.kind === "interface") {
    assert.equal(iface.program.body[0].members.length, 2);
    assert.equal(iface.program.body[0].members[0]?.kind, "prop");
    if (iface.program.body[0].members[0]?.kind === "prop") {
      assert.equal(iface.program.body[0].members[0].optional, true);
    }
    assert.equal(iface.program.body[0].members[1]?.kind, "method_sig");
  }

  const cls = parse(
    `class C {
      x: number;
      constructor(a: number) {}
      m(b: string): void {}
    }`,
    "t.jsv",
  );
  assert.equal(cls.diagnostics.length, 0);
  if (cls.program.body[0]?.kind === "class") {
    assert.equal(cls.program.body[0].members.length, 3);
    assert.equal(cls.program.body[0].members[0]?.kind, "field");
    assert.equal(cls.program.body[0].members[1]?.kind, "constructor");
    assert.equal(cls.program.body[0].members[2]?.kind, "method");
  }
});

test("for / if / while / return", () => {
  const f = parse("for (let i = 0; i < 10; i = i + 1) {}", "t.jsv");
  assert.equal(f.diagnostics.length, 0);
  assert.equal(f.program.body[0]?.kind, "for");

  const i = parse("if (true) { return; } else { return 1; }", "t.jsv");
  assert.equal(i.diagnostics.length, 0);
  assert.equal(i.program.body[0]?.kind, "if");

  const w = parse("while (false) return;", "t.jsv");
  assert.equal(w.diagnostics.length, 0);
  assert.equal(w.program.body[0]?.kind, "while");
});

test("missing semicolon reports unexpected_token with 1-based span", () => {
  // Fixture: `let x = 1` on line 1 with no semicolon; the unexpected token
  // is EOF at column 10 (after `1`), or the next statement. Here EOF.
  const { diagnostics } = parse("let x = 1", "t.jsv");
  const d = diagnostics.find(
    (x) =>
      x.code === "jsv.parse.unexpected_token" ||
      x.code === "jsv.parse.unexpected_eof",
  );
  assert.ok(d);
  assert.equal(d?.start?.line, 1);
  assert.ok((d?.start?.column ?? 0) >= 1);
});

test("expression a | b reports unsupported_operator", () => {
  const { diagnostics } = parse("a | b;", "t.jsv");
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.unsupported_operator"),
  );
});

test("two errors in one file both appear (recovery)", () => {
  const { diagnostics } = parse("a | b; const x;", "t.jsv");
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.unsupported_operator"),
  );
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.const_missing_init"),
  );
});

test("export default type reports invalid_default_export", () => {
  const { diagnostics } = parse(
    "export default type T = number;",
    "t.jsv",
  );
  assert.ok(
    diagnostics.some((d) => d.code === "jsv.parse.invalid_default_export"),
  );
});

test("class extends reports unsupported", () => {
  const { diagnostics } = parse("class C extends B {}", "t.jsv");
  assert.ok(diagnostics.some((d) => d.code === "jsv.parse.unsupported"));
});

test("bad class member recovers; later field kept", () => {
  const { program, diagnostics } = parse(
    "class C { 1; x: number; }",
    "t.jsv",
  );
  assert.ok(diagnostics.some((d) => d.code.startsWith("jsv.parse.")));
  assert.equal(program.body[0]?.kind, "class");
  if (program.body[0]?.kind === "class") {
    assert.ok(
      program.body[0].members.some(
        (m) => m.kind === "field" && m.name === "x",
      ),
    );
  }
});

test("bad interface member recovers; later prop kept", () => {
  const { program, diagnostics } = parse(
    "interface I { 1; x: number; }",
    "t.jsv",
  );
  assert.ok(diagnostics.some((d) => d.code.startsWith("jsv.parse.")));
  assert.equal(program.body[0]?.kind, "interface");
  if (program.body[0]?.kind === "interface") {
    assert.ok(
      program.body[0].members.some(
        (m) => m.kind === "prop" && m.name === "x",
      ),
    );
  }
});

test("bad object-type member recovers; later prop kept", () => {
  const { program, diagnostics } = parse(
    "type T = { 1; x: number; };",
    "t.jsv",
  );
  assert.ok(diagnostics.some((d) => d.code.startsWith("jsv.parse.")));
  assert.equal(program.body[0]?.kind, "type_alias");
  if (program.body[0]?.kind === "type_alias") {
    const t = program.body[0].type;
    assert.equal(t.kind, "object");
    if (t.kind === "object") {
      assert.ok(
        t.members.some((m) => m.kind === "prop" && m.name === "x"),
      );
    }
  }
});

test("optional chaining, nullish coalescing, and async parse", () => {
  const chain = exprStmt(parse("a?.b?.c;", "t.jsv").program.body);
  assert.equal(chain.kind, "member");
  if (chain.kind === "member") {
    assert.equal(chain.optional, true);
    assert.equal(chain.property, "c");
    assert.equal(chain.object.kind, "member");
    if (chain.object.kind === "member") assert.equal(chain.object.optional, true);
  }

  const call = exprStmt(parse("a?.b();", "t.jsv").program.body);
  assert.equal(call.kind, "call");
  if (call.kind === "call") {
    assert.equal(call.optional, false);
    assert.equal(call.callee.kind, "member");
    if (call.callee.kind === "member") assert.equal(call.callee.optional, true);
  }

  const optCall = exprStmt(parse("fn?.();", "t.jsv").program.body);
  assert.equal(optCall.kind, "call");
  if (optCall.kind === "call") assert.equal(optCall.optional, true);

  const index = exprStmt(parse("xs?.[0];", "t.jsv").program.body);
  assert.equal(index.kind, "index");
  if (index.kind === "index") assert.equal(index.optional, true);

  const coalesced = exprStmt(parse("a ?? b ?? c;", "t.jsv").program.body);
  assert.equal(coalesced.kind, "binary");
  if (coalesced.kind === "binary") {
    assert.equal(coalesced.op, "??");
    assert.equal(coalesced.left.kind, "binary");
    if (coalesced.left.kind === "binary") assert.equal(coalesced.left.op, "??");
  }

  const tighter = exprStmt(parse("1 + 2 ?? 3;", "t.jsv").program.body);
  assert.equal(tighter.kind, "binary");
  if (tighter.kind === "binary") {
    assert.equal(tighter.op, "??");
    assert.equal(tighter.left.kind, "binary");
  }

  const mixed = parse("a ?? b || c;", "t.jsv");
  assert.ok(mixed.diagnostics.some((d) => d.code === "jsv.parse.mixed_nullish"));

  const grouped = parse("(a || b) ?? c;", "t.jsv");
  assert.equal(grouped.diagnostics.length, 0);
  const groupedExpr = exprStmt(grouped.program.body);
  assert.equal(groupedExpr.kind, "binary");
  if (groupedExpr.kind === "binary") {
    assert.equal(groupedExpr.op, "??");
    assert.equal(groupedExpr.left.kind, "binary");
  }

  const assign = parse("a?.b = 1;", "t.jsv");
  assert.ok(
    assign.diagnostics.some((d) => d.code === "jsv.parse.invalid_assignment_target"),
  );

  const closed = parse("(a?.b).c = 1;", "t.jsv");
  assert.equal(closed.diagnostics.length, 0);
  const closedExpr = exprStmt(closed.program.body);
  assert.equal(closedExpr.kind, "assign");
  if (closedExpr.kind === "assign" && closedExpr.target.kind === "member") {
    assert.equal(closedExpr.target.optional, false);
    assert.equal(closedExpr.target.object.kind, "member");
    if (closedExpr.target.object.kind === "member") {
      assert.equal(closedExpr.target.object.stopChain, true);
    }
  }

  const bare = parse("a?.;", "t.jsv");
  assert.ok(bare.diagnostics.some((d) => d.code === "jsv.parse.optional_chain"));
});

test("optional parameters, async functions, and class members", () => {
  const fn = parse(
    "async function f(x?: number): Promise<number> { return x ?? 0; }",
    "t.jsv",
  );
  assert.equal(fn.diagnostics.length, 0);
  const decl = fn.program.body[0];
  assert.equal(decl?.kind, "function");
  if (decl?.kind === "function") {
    assert.equal(decl.async, true);
    assert.equal(decl.params[0]?.optional, true);
  }

  const order = parse(
    "function f(a?: number, b: number): void {}",
    "t.jsv",
  );
  assert.ok(
    order.diagnostics.some((d) => d.code === "jsv.parse.required_after_optional"),
  );

  const arrow = parse("let f = async (x?: number) => x ?? 0;", "t.jsv");
  assert.equal(arrow.diagnostics.length, 0);
  const arrowStmt = arrow.program.body[0];
  assert.equal(arrowStmt?.kind, "var");
  if (arrowStmt?.kind === "var" && arrowStmt.init?.kind === "arrow") {
    assert.equal(arrowStmt.init.async, true);
    assert.equal(arrowStmt.init.params[0]?.optional, true);
  }

  const badAsync = parse("async 1;", "t.jsv");
  assert.ok(badAsync.diagnostics.some((d) => d.code === "jsv.parse.unsupported"));

  const cls = parse(
    `class C {
  name?: string;
  async get(): Promise<number> { return 1; }
}`,
    "t.jsv",
  );
  assert.equal(cls.diagnostics.length, 0);
  const classDecl = cls.program.body[0];
  assert.equal(classDecl?.kind, "class");
  if (classDecl?.kind === "class") {
    assert.equal(classDecl.members[0]?.kind, "field");
    if (classDecl.members[0]?.kind === "field") {
      assert.equal(classDecl.members[0].optional, true);
    }
    assert.equal(classDecl.members[1]?.kind, "method");
    if (classDecl.members[1]?.kind === "method") {
      assert.equal(classDecl.members[1].async, true);
    }
  }

  const optMethod = parse("class C { m?(): void {} m?<T>(x: T): T { return x; } }", "t.jsv");
  assert.ok(
    optMethod.diagnostics.filter((d) => d.code === "jsv.parse.unsupported").length >= 2,
  );

  const iface = parse(
    "interface I { n?: string; m?<T>(x: T): T; }",
    "t.jsv",
  );
  assert.equal(iface.diagnostics.length, 0);
  const idecl = iface.program.body[0];
  assert.equal(idecl?.kind, "interface");
  if (idecl?.kind === "interface") {
    assert.equal(idecl.members[0]?.kind, "prop");
    if (idecl.members[0]?.kind === "prop") assert.equal(idecl.members[0].optional, true);
    assert.equal(idecl.members[1]?.kind, "method_sig");
    if (idecl.members[1]?.kind === "method_sig") {
      assert.equal(idecl.members[1].optional, true);
      assert.equal(idecl.members[1].typeParams.length, 1);
    }
  }
});

test("empty class and valid interface still clean", () => {
  assert.equal(parse("class C { }", "t.jsv").diagnostics.length, 0);
  assert.equal(
    parse("interface I { x: number; }", "t.jsv").diagnostics.length,
    0,
  );
});
