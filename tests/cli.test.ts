import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(root, "src", "cli.ts");
const pkg = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
) as { version: string };

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", cliPath, ...args],
    {
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

test("version prints the package.json version", () => {
  for (const args of [["version"], ["--version"], ["-v"]] as const) {
    const result = runCli(args);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), pkg.version);
  }
});

test("help mentions check and run", () => {
  for (const args of [["help"], ["--help"], ["-h"]] as const) {
    const result = runCli(args);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /check <file\.jsv>/);
    assert.match(result.stdout, /run <file\.jsv>/);
    assert.match(result.stdout, /--format json\|text/);
  }
});

test("missing path yields jsv.missing_path", () => {
  for (const command of ["check", "run"] as const) {
    const result = runCli([command]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /jsv\.missing_path/);
  }
});

test("file not found yields jsv.file_not_found", () => {
  const missing = join(root, "does-not-exist.jsv");
  const result = runCli(["check", missing]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /jsv\.file_not_found/);
});

test("bad extension yields jsv.bad_extension", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-"));
  try {
    const file = join(dir, "sample.ts");
    writeFileSync(file, "// not jsv\n");
    const result = runCli(["run", file]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /jsv\.bad_extension/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check of comment-only .jsv parses and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-"));
  try {
    const file = join(dir, "sample.jsv");
    writeFileSync(file, "// placeholder\n");
    const result = runCli(["check", file]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check --format json success is ok with empty diagnostics", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-"));
  try {
    const file = join(dir, "sample.jsv");
    writeFileSync(file, "// ok\n");
    const result = runCli(["check", "--format", "json", file]);
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

test("run of valid .jsv exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-"));
  try {
    const file = join(dir, "sample.jsv");
    writeFileSync(file, 'console.log("ok");\n');
    const result = runCli(["run", file]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run of type error exits 1 with jsv.check.not_assignable and does not execute", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-"));
  try {
    const file = join(dir, "bad.jsv");
    writeFileSync(file, 'let x: string = 1;\nconsole.log("ran");\n');
    const result = runCli(["run", file]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /jsv\.check\.not_assignable/);
    assert.doesNotMatch(result.stdout, /ran/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check syntax error exits 1 with jsv.parse.* and 1-based span", () => {
  const dir = mkdtempSync(join(tmpdir(), "jsv2-"));
  try {
    const file = join(dir, "bad.jsv");
    writeFileSync(file, "let x = ;\n");
    const result = runCli(["check", "--format", "json", file]);
    assert.equal(result.status, 1);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      diagnostics: Array<{
        code: string;
        start?: { line: number; column: number };
      }>;
    };
    assert.equal(parsed.ok, false);
    const d = parsed.diagnostics[0];
    assert.ok(d);
    assert.match(d.code, /^jsv\.parse\./);
    assert.equal(typeof d.start?.line, "number");
    assert.equal(typeof d.start?.column, "number");
    assert.ok((d.start?.line ?? 0) >= 1);
    assert.ok((d.start?.column ?? 0) >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown command yields jsv.unknown_command", () => {
  const result = runCli(["frobnicate"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /jsv\.unknown_command/);
});

test("json format parses and includes the expected code", () => {
  const result = runCli(["check", "--format", "json"]);
  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    diagnostics: Array<{ code: string }>;
  };
  assert.equal(parsed.ok, false);
  assert.equal(parsed.diagnostics[0]?.code, "jsv.missing_path");
});

test("text format includes the code", () => {
  const result = runCli(["check", "--format", "text"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /jsv\.missing_path/);
});
