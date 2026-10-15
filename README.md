# JSV2

JSV2 is a constrained TypeScript-like language aimed at agentic coding. The long-term plan includes a DOM/reactivity model so React is unnecessary, a hot runtime in Go/WASM, and language intelligence via an MCP server. Those pieces are not implemented yet.

This repository currently provides the project skeleton, a hand-written lexer/parser and type checker for the JSV2 subset, TypeScript build/check tooling, and a CLI (`jsv`). The runtime and MCP server are not implemented yet.

## Requirements

- Node.js v23.5.0+ (CLI runs with `node --experimental-strip-types`)

## Setup

```bash
npm install
```

## Make targets

| Target | What it does |
|--------|----------------|
| `make check` | `tsc --noEmit` (strict typecheck) |
| `make test` | `node --experimental-strip-types --test` on `tests/*.ts`, `tests/parser/*.ts`, and `tests/checker/*.ts` |
| `make build` | Compile TypeScript to `dist/` with `tsc` |

`make build` assumes dependencies are already installed.

## CLI (`jsv`)

Run from source:

```bash
node --experimental-strip-types src/cli.ts <command> [options]
```

After `make build`, the `bin/jsv` shim loads `dist/cli.js`.

| Command | Behavior today |
|---------|----------------|
| `jsv version` / `--version` / `-v` | Print package version |
| `jsv help` / `--help` / `-h` | Print usage |
| `jsv check <file.jsv>` | Parse then typecheck; exit 0 on success, exit 1 on diagnostics. Typechecking is skipped when the parse fails |
| `jsv run <file.jsv>` | Validate path/extension; then report `jsv.not_implemented` (exit 2) |

Options:

- `--format text` (default) — one human-readable diagnostic line per issue (includes the code); success prints nothing
- `--format json` — single JSON object `{ "ok": boolean, "diagnostics": Diagnostic[] }` on stdout

Diagnostics always go to stdout. See [docs/syntax.md](docs/syntax.md) for the language subset and [docs/types.md](docs/types.md) for typechecker rules. DOM runtime, WASM, and MCP are not implemented yet.
