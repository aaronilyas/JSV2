import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkFile, checkSource } from "../../src/checker/check.ts";
import type { Diagnostic } from "../../src/diagnostics.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cliPath = join(root, "src", "cli.ts");

function hasCode(diags: readonly Diagnostic[], code: string): boolean {
  return diags.some((d) => d.code === code);
}

function check(source: string): Diagnostic[] {
  return checkSource(source, "t.jsv").diagnostics;
}

test("string assigned to number is not_assignable", () => {
  const d = check('let x: number = "a";');
  assert.ok(hasCode(d, "jsv.check.not_assignable"));
  assert.match(
    d.find((x) => x.code === "jsv.check.not_assignable")!.message,
    /string.*number/,
  );
});

test("inferred let and uninitialized let", () => {
  const ok = check("let x = 1; let y: number = x;");
  assert.equal(ok.length, 0);

  const bad = check("let x: number;");
  assert.ok(hasCode(bad, "jsv.check.uninitialized"));
});

test("const reassignment is assign_const", () => {
  const d = check("const x = 1; x = 2;");
  assert.ok(hasCode(d, "jsv.check.assign_const"));
});

test("missing return and wrong return type", () => {
  const missing = check("function f(): number {}");
  assert.ok(hasCode(missing, "jsv.check.missing_return"));

  const wrong = check("function f(): number { return \"a\"; }");
  assert.ok(hasCode(wrong, "jsv.check.not_assignable"));
});

test("console.log ok; void value from console.log is void_value", () => {
  const ok = check('console.log(1, "a");');
  assert.equal(ok.length, 0);

  const bad = check("let x = console.log(1);");
  assert.ok(hasCode(bad, "jsv.check.void_value"));
});

test("if (1) is condition_not_boolean", () => {
  const d = check("if (1) {}");
  assert.ok(hasCode(d, "jsv.check.condition_not_boolean"));
});

test("null narrowing on identifier", () => {
  const ok = check(
    "let x: string | null = null; if (x !== null) { let y: string = x; }",
  );
  assert.equal(ok.length, 0);

  const elseBad = check(
    "let x: string | null = null; if (x !== null) {} else { let y: string = x; }",
  );
  assert.ok(hasCode(elseBad, "jsv.check.not_assignable"));
});

test("arithmetic and string concatenation", () => {
  assert.equal(check("let x: number = 1 + 2 * 3;").length, 0);

  const str = check('let s: string = "a" + 1;');
  assert.equal(str.length, 0);

  const bad = check("let z = true + 1;");
  assert.ok(hasCode(bad, "jsv.check.bad_operator"));
});

test("object literal excess property", () => {
  const d = check(
    "let o: { a: number; } = { a: 1, b: 2 };",
  );
  assert.ok(hasCode(d, "jsv.check.not_assignable"));
  assert.match(
    d.find((x) => x.code === "jsv.check.not_assignable")!.message,
    /b/,
  );
});

test("optional property read includes undefined", () => {
  const d = check(
    "let o: { a?: string; } = {}; let s: string = o.a;",
  );
  assert.ok(hasCode(d, "jsv.check.not_assignable"));
});

test("generic function requires explicit type arguments", () => {
  const missing = check(
    "function id<T>(x: T): T { return x; } id(1);",
  );
  assert.ok(hasCode(missing, "jsv.check.missing_type_arguments"));

  const ok = check(
    "function id<T>(x: T): T { return x; } let n: number = id<number>(1);",
  );
  assert.equal(ok.length, 0);
});

test("generic interface requires type arguments", () => {
  const ok = check(
    "interface Box<T> { value: T; } let b: Box<number> = { value: 1 };",
  );
  assert.equal(ok.length, 0);

  const missing = check(
    "interface Box<T> { value: T; } let b: Box = { value: 1 };",
  );
  assert.ok(hasCode(missing, "jsv.check.missing_type_arguments"));
});

test("class field, constructor, this, new", () => {
  const ok = check(`
class C {
  x: number;
  constructor(x: number) {
    this.x = x;
  }
}
let c: C = new C(1);
let n: number = c.x;
`);
  assert.equal(ok.length, 0);

  const missing = check(`
class C {
  x: number;
  constructor() {
    this.y = 1;
  }
}
`);
  assert.ok(hasCode(missing, "jsv.check.missing_property"));
});

test("imports: named, missing, default not named, type as value", () => {
  const files = new Map<string, string>([
    [
      resolve("/virtual/a.jsv"),
      "export let a: number = 1; export default function d(): void {} export type T = number;",
    ],
    [
      resolve("/virtual/main.jsv"),
      `import { a } from "./a.jsv";
import { missing } from "./a.jsv";
import { d } from "./a.jsv";
import { T } from "./a.jsv";
let x: number = a;
let y = T;
`,
    ],
  ]);

  const { diagnostics } = checkSource(
    files.get(resolve("/virtual/main.jsv"))!,
    "/virtual/main.jsv",
    {
      readFile: (p) => files.get(p) ?? null,
    },
  );

  assert.ok(hasCode(diagnostics, "jsv.check.missing_export"));
  // default export d is not a named export
  assert.ok(
    diagnostics.some(
      (d) =>
        d.code === "jsv.check.missing_export" &&
        d.message.includes("'d'"),
    ),
  );
  assert.ok(hasCode(diagnostics, "jsv.check.type_as_value"));
  // named export a succeeds — no error on `let x: number = a`
  assert.ok(
    !diagnostics.some(
      (d) =>
        d.code === "jsv.check.not_assignable" &&
        (d.message.includes("'a'") || d.file?.endsWith("main.jsv") === true) &&
        d.message.includes("number") &&
        d.start?.line === 5,
    ),
  );
});

test("import cycle reports import_cycle and terminates", () => {
  const files = new Map<string, string>([
    [
      resolve("/virtual/a.jsv"),
      'import { b } from "./b.jsv"; export let a: number = 1;',
    ],
    [
      resolve("/virtual/b.jsv"),
      'import { a } from "./a.jsv"; export let b: number = 1;',
    ],
  ]);

  const { diagnostics } = checkSource(
    files.get(resolve("/virtual/a.jsv"))!,
    "/virtual/a.jsv",
    { readFile: (p) => files.get(p) ?? null },
  );
  assert.ok(hasCode(diagnostics, "jsv.check.import_cycle"));
});

test("unresolved name", () => {
  const d = check("let x = notDefined;");
  assert.ok(hasCode(d, "jsv.check.unresolved_name"));
});

test("assertions: unknown ok, unrelated impossible", () => {
  const ok = check("let x: unknown = 1; let y: number = x as number;");
  assert.equal(ok.length, 0);

  const bad = check('let y: number = "a" as number;');
  assert.ok(hasCode(bad, "jsv.check.impossible_assertion"));
});

test("empty array without annotation", () => {
  const d = check("let x = [];");
  assert.ok(hasCode(d, "jsv.check.empty_array"));
});

test("duplicate declaration", () => {
  const d = check("let x = 1; let x = 2;");
  assert.ok(hasCode(d, "jsv.check.duplicate_declaration"));
});

test("parse error skips typecheck", () => {
  const d = check("let a = 1");
  assert.ok(d.some((x) => x.code.startsWith("jsv.parse.")));
  assert.ok(!d.some((x) => x.code.startsWith("jsv.check.")));
});

test("CLI check type error exits 1 with json spans", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-check-"));
  try {
    const file = join(dir, "bad.jsv");
    writeFileSync(file, 'let x: number = "a";\n');
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cliPath, "check", "--format", "json", file],
      {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      diagnostics: Array<{
        code: string;
        start?: { line: number; column: number };
      }>;
    };
    assert.equal(parsed.ok, false);
    const d = parsed.diagnostics.find(
      (x) => x.code === "jsv.check.not_assignable",
    );
    assert.ok(d);
    assert.equal(typeof d?.start?.line, "number");
    assert.equal(typeof d?.start?.column, "number");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI check valid file exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-check-ok-"));
  try {
    const file = join(dir, "ok.jsv");
    writeFileSync(file, "let x: number = 1;\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", cliPath, "check", "--format", "json", file],
      {
        encoding: "utf8",
        cwd: root,
        env: { ...process.env, NODE_NO_WARNINGS: "1" },
      },
    );
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      diagnostics: unknown[];
    };
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.diagnostics, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkFile missing module yields module_not_found", () => {
  const { diagnostics } = checkFile("/no/such/file.jsv", {
    readFile: () => null,
  });
  assert.ok(hasCode(diagnostics, "jsv.check.module_not_found"));
});

test("typeof narrowing", () => {
  const ok = check(
    'let x: string | number = 1; if (typeof x === "string") { let y: string = x; }',
  );
  assert.equal(ok.length, 0);
});

test("union is assignable to itself and related unions", () => {
  assert.equal(
    check(
      "function f(x: string | number): string | number { return x; }",
    ).length,
    0,
  );
  assert.equal(
    check("let x: string | number = 1; let y: string | number = x;").length,
    0,
  );
  assert.equal(check("let a: (number | string)[] = [1];").length, 0);
  assert.equal(
    check(
      "type L = { next: L | null; }; function id(x: L): L { return x; }",
    ).length,
    0,
  );
  assert.equal(
    check("type L = { next: L | null; }; let l: L = { next: null };").length,
    0,
  );
  assert.equal(
    check("let x: number | boolean = true; let y: boolean | number = x;").length,
    0,
  );
  assert.equal(check("let x: null = null; let y: string | null = x;").length, 0);
  assert.ok(
    hasCode(
      check('let x: string = "a"; let y: number | null = x;'),
      "jsv.check.not_assignable",
    ),
  );
  assert.ok(
    hasCode(
      check("let x: string | number = 1; let y: boolean | number = x;"),
      "jsv.check.not_assignable",
    ),
  );
});

test("optional property write accepts undefined", () => {
  assert.equal(
    check("let o: { a?: number; } = { a: 1 }; o.a = undefined;").length,
    0,
  );
  assert.ok(
    hasCode(
      check("let o: { a: number; } = { a: 1 }; o.a = undefined;"),
      "jsv.check.not_assignable",
    ),
  );
});

test("console can be shadowed; ambient console is not mutable", () => {
  assert.equal(
    check("let console: number = 1; let n: number = console;").length,
    0,
  );
  assert.ok(hasCode(check("console = 1;"), "jsv.check.assign_const"));
});
