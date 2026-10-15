import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  checkFile,
  checkSource,
  typeAt,
} from "../checker/check.ts";
import { diagnosticsResult, type Diagnostic } from "../diagnostics.ts";
import { domAnalyze } from "./dom-analyze.ts";
import { suggestFix } from "./fixes.ts";

const VERSION = "0.1.0";

const missingInputDiagnostic: Diagnostic = {
  code: "jsv.mcp.missing_input",
  severity: "error",
  message: "Provide source or path.",
};

function textResult(value: unknown): {
  content: [{ type: "text"; text: string }];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
  };
}

function resolveSourceInput(args: {
  source?: string;
  path?: string;
}):
  | { ok: true; source: string; file: string; fromPath: boolean }
  | { ok: false; diagnostic: Diagnostic } {
  const path =
    typeof args.path === "string" && args.path.length > 0 ? args.path : null;
  if (path !== null) {
    const absolute = resolve(path);
    try {
      const source = readFileSync(absolute, "utf8");
      return { ok: true, source, file: absolute, fromPath: true };
    } catch {
      return {
        ok: false,
        diagnostic: {
          code: "jsv.check.module_not_found",
          severity: "error",
          message: `Module not found: '${path}'.`,
          file: absolute,
        },
      };
    }
  }
  if (typeof args.source === "string") {
    return {
      ok: true,
      source: args.source,
      file: "<stdin>.jsv",
      fromPath: false,
    };
  }
  return { ok: false, diagnostic: missingInputDiagnostic };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "jsv2", version: VERSION });

  server.registerTool(
    "check",
    {
      description:
        "Typecheck a JSV2 source string or file. Returns ok and diagnostics.",
      inputSchema: z.object({
        source: z.string().optional(),
        path: z.string().optional(),
      }),
    },
    (args) => {
      const path =
        typeof args.path === "string" && args.path.length > 0
          ? args.path
          : null;
      if (path !== null) {
        return textResult(diagnosticsResult(checkFile(path).diagnostics));
      }
      if (typeof args.source === "string") {
        return textResult(
          diagnosticsResult(
            checkSource(args.source, "<stdin>.jsv", {
              readFile: () => null,
            }).diagnostics,
          ),
        );
      }
      return textResult(diagnosticsResult([missingInputDiagnostic]));
    },
  );

  server.registerTool(
    "typeOf",
    {
      description:
        "Return the type at a 1-based line/column (UTF-16) in JSV2 source.",
      inputSchema: z.object({
        source: z.string().optional(),
        path: z.string().optional(),
        line: z.number().int(),
        column: z.number().int(),
      }),
    },
    (args) => {
      const resolved = resolveSourceInput(args);
      if (!resolved.ok) {
        return textResult({
          found: false,
          diagnostics: [resolved.diagnostic],
        });
      }
      const options = resolved.fromPath
        ? undefined
        : { readFile: () => null };
      const { hit, diagnostics } = typeAt(
        resolved.source,
        resolved.file,
        args.line,
        args.column,
        options,
      );
      if (hit === null) {
        return textResult({ found: false, diagnostics });
      }
      return textResult({
        found: true,
        type: hit.type,
        start: hit.start,
        end: hit.end,
        diagnostics,
      });
    },
  );

  server.registerTool(
    "suggestFix",
    {
      description:
        "Suggest a text edit for a diagnostic at a position (semicolon insert only).",
      inputSchema: z.object({
        source: z.string().optional(),
        path: z.string().optional(),
        code: z.string(),
        line: z.number().int(),
        column: z.number().int(),
      }),
    },
    (args) => {
      const resolved = resolveSourceInput(args);
      if (!resolved.ok) {
        return textResult({
          applicable: false,
          edits: [],
          message: resolved.diagnostic.message,
          diagnostics: [resolved.diagnostic],
        });
      }
      const options = resolved.fromPath
        ? undefined
        : { readFile: () => null };
      return textResult(
        suggestFix(
          resolved.source,
          resolved.file,
          args.code,
          args.line,
          args.column,
          options,
        ),
      );
    },
  );

  server.registerTool(
    "domAnalyze",
    {
      description:
        "Static analysis of jsv/dom signal/effect/list usage (no WASM).",
      inputSchema: z.object({
        source: z.string().optional(),
        path: z.string().optional(),
      }),
    },
    (args) => {
      const resolved = resolveSourceInput(args);
      if (!resolved.ok) {
        // `issues` is DOM-only. Input failures belong in `diagnostics`.
        return textResult({
          signals: [],
          effects: [],
          lists: [],
          issues: [],
          diagnostics: [resolved.diagnostic],
        });
      }
      return textResult(domAnalyze(resolved.source, resolved.file));
    },
  );

  return server;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(entry);
  } catch {
    return false;
  }
}

if (isMain()) {
  // Exit when the client closes stdin (EOF), even if the SDK keeps handles open.
  const exitOnStdinEnd = (): void => {
    process.exit(0);
  };
  process.stdin.on("end", exitOnStdinEnd);
  process.stdin.on("close", exitOnStdinEnd);

  serveStdio(() => createServer());
}
