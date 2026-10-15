import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkFile } from "../checker/check.ts";
import {
  type Diagnostic,
  diagnosticsResult,
  formatDiagnosticsText,
} from "../diagnostics.ts";
import { parse } from "../parser/parse.ts";
import type { Program } from "../parser/ast.ts";
import {
  collectValueExports,
  emitProgram,
  jsvDomRuntimeSpecifier,
  JSV_DOM_VALUE_NAMES,
  type EmitOptions,
} from "./emit.ts";

export type Format = "json" | "text";

function emitDiagnostics(
  diagnostics: readonly Diagnostic[],
  format: Format,
): void {
  if (format === "json") {
    process.stdout.write(
      `${JSON.stringify(diagnosticsResult(diagnostics))}\n`,
    );
    return;
  }
  const text = formatDiagnosticsText(diagnostics);
  if (text.length > 0) {
    process.stdout.write(`${text}\n`);
  }
}

function readSource(absolutePath: string): string {
  return readFileSync(absolutePath, "utf8");
}

function collectModules(
  entryAbs: string,
): Map<string, { program: Program; outName: string }> {
  const modules = new Map<string, { program: Program; outName: string }>();
  const queue: string[] = [entryAbs];
  let modCounter = 0;

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;

    const source = readSource(file);
    const { program, diagnostics } = parse(source, file);
    if (diagnostics.length > 0) {
      throw new Error(
        `parse failed for ${file}: ${diagnostics.map((d) => d.message).join("; ")}`,
      );
    }

    const outName =
      file === entryAbs ? "entry.mjs" : `mod${modCounter++}.mjs`;
    modules.set(file, { program, outName });

    for (const stmt of program.body) {
      if (stmt.kind !== "import") continue;
      const spec = stmt.moduleSpecifier;
      if (spec === "jsv/dom") continue;
      if (spec.startsWith("./") || spec.startsWith("../")) {
        queue.push(resolve(dirname(file), spec));
      }
    }
  }

  return modules;
}

function emitOptionsFor(
  file: string,
  modules: Map<string, { program: Program; outName: string }>,
  runtimeSpecifier: string,
): EmitOptions {
  return {
    resolveImport(moduleSpecifier: string) {
      if (moduleSpecifier === "jsv/dom") {
        return {
          specifier: runtimeSpecifier,
          isValue: (name) => JSV_DOM_VALUE_NAMES.has(name),
          hasDefault: false,
        };
      }
      const abs = resolve(dirname(file), moduleSpecifier);
      const dep = modules.get(abs);
      if (dep === undefined) {
        return {
          specifier: moduleSpecifier,
          isValue: () => true,
          hasDefault: true,
        };
      }
      const exports = collectValueExports(dep.program);
      return {
        specifier: `./${dep.outName}`,
        isValue: (name) => exports.named.has(name),
        hasDefault: exports.hasDefault,
      };
    },
  };
}

function writeEmittedModules(
  entryAbs: string,
  outDir: string,
): string {
  const modules = collectModules(entryAbs);
  const runtimeSpecifier = jsvDomRuntimeSpecifier();

  for (const [file, mod] of modules) {
    const code = emitProgram(
      mod.program,
      emitOptionsFor(file, modules, runtimeSpecifier),
    );
    writeFileSync(join(outDir, mod.outName), code, "utf8");
  }

  const entry = modules.get(entryAbs);
  if (entry === undefined) {
    throw new Error(`entry module missing: ${entryAbs}`);
  }
  return join(outDir, entry.outName);
}

export class CheckFailedError extends Error {
  readonly diagnostics: Diagnostic[];

  constructor(diagnostics: Diagnostic[]) {
    super(
      diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n") ||
        "typecheck failed",
    );
    this.name = "CheckFailedError";
    this.diagnostics = diagnostics;
  }
}

/**
 * Typecheck, emit, and import a `.jsv` module. Caller must invoke `cleanup`
 * (removes the temp emit directory). Throws `CheckFailedError` if typecheck
 * fails (no temp dir is created).
 */
export async function loadModule(
  file: string,
): Promise<{
  namespace: Record<string, unknown>;
  cleanup: () => Promise<void>;
}> {
  const absolute = resolve(file);
  const { diagnostics } = checkFile(absolute);
  if (diagnostics.length > 0) {
    throw new CheckFailedError(diagnostics);
  }

  const outDir = mkdtempSync(join(tmpdir(), "jsv-run-"));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    rmSync(outDir, { recursive: true, force: true });
  };

  try {
    const entryPath = writeEmittedModules(absolute, outDir);
    const mod = await import(pathToFileURL(entryPath).href);
    const namespace: Record<string, unknown> = { ...mod };
    return { namespace, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

export async function runFile(
  file: string,
  format: Format = "text",
): Promise<number> {
  const absolute = resolve(file);
  const { diagnostics } = checkFile(absolute);
  if (diagnostics.length > 0) {
    emitDiagnostics(diagnostics, format);
    return 1;
  }

  const outDir = mkdtempSync(join(tmpdir(), "jsv-run-"));
  try {
    const entryPath = writeEmittedModules(absolute, outDir);
    await import(pathToFileURL(entryPath).href);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}
