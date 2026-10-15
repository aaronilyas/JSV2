import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkFile } from "./checker/check.ts";
import {
  type Diagnostic,
  diagnosticsResult,
  formatDiagnosticsText,
} from "./diagnostics.ts";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");

export const VERSION: string = (
  JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
    version: string;
  }
).version;

const USAGE = `Usage: jsv <command> [options]

Commands:
  version              Print the jsv2 package version
  help                 Show this help
  check <file.jsv>     Parse and typecheck a JSV2 source file
  run <file.jsv>       Run a JSV2 source file

Options:
  -h, --help           Show this help
  -v, --version        Print the jsv2 package version
  --format json|text   Diagnostic output format (default: text)
`;

function emitDiagnostics(
  diagnostics: readonly Diagnostic[],
  format: string,
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

function errorDiagnostic(
  code: string,
  message: string,
  file?: string,
): Diagnostic {
  const d: Diagnostic = {
    code,
    severity: "error",
    message,
  };
  if (file !== undefined) {
    d.file = file;
  }
  return d;
}

function handleFileCommand(
  command: "check" | "run",
  filePath: string | undefined,
  format: string,
): number {
  if (filePath === undefined || filePath.length === 0) {
    emitDiagnostics(
      [
        errorDiagnostic(
          "jsv.missing_path",
          `${command} requires a path to a .jsv file`,
        ),
      ],
      format,
    );
    return 1;
  }

  if (!existsSync(filePath)) {
    emitDiagnostics(
      [
        errorDiagnostic(
          "jsv.file_not_found",
          `file not found: ${filePath}`,
          filePath,
        ),
      ],
      format,
    );
    return 1;
  }

  if (extname(filePath) !== ".jsv") {
    emitDiagnostics(
      [
        errorDiagnostic(
          "jsv.bad_extension",
          `expected a .jsv file, got: ${filePath}`,
          filePath,
        ),
      ],
      format,
    );
    return 1;
  }

  if (command === "run") {
    emitDiagnostics(
      [
        errorDiagnostic(
          "jsv.not_implemented",
          "run is not implemented yet",
          filePath,
        ),
      ],
      format,
    );
    return 2;
  }

  const { diagnostics } = checkFile(filePath);
  emitDiagnostics(diagnostics, format);
  return diagnostics.length > 0 ? 1 : 0;
}

export function main(argv: readonly string[]): number {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      version: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      format: { type: "string", default: "text" },
    },
    allowPositionals: true,
    strict: false,
  });

  const format = values.format === "json" ? "json" : "text";

  if (values.version === true) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (values.help === true) {
    process.stdout.write(USAGE);
    return 0;
  }

  const command = positionals[0];

  if (command === undefined || command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  if (command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (command === "check" || command === "run") {
    return handleFileCommand(command, positionals[1], format);
  }

  emitDiagnostics(
    [
      errorDiagnostic(
        "jsv.unknown_command",
        `unknown command: ${command}`,
      ),
    ],
    format,
  );
  return 1;
}

const entry = process.argv[1];
if (
  entry !== undefined &&
  fileURLToPath(import.meta.url) === resolve(entry)
) {
  process.exit(main(process.argv.slice(2)));
}
