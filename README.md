# JSV2

JSV2 is a constrained TypeScript-like language aimed at agentic coding. The long-term plan includes a DOM/reactivity model so React is unnecessary, a hot runtime in Go/WASM, and language intelligence via an MCP server. Those pieces are not implemented yet.

This repository currently provides the project skeleton, TypeScript build/check tooling, and a stub CLI (`jsv`).

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
| `make test` | `node --experimental-strip-types --test` on `tests/**/*.ts` |
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
| `jsv check <file.jsv>` | Validate path/extension; then report `jsv.not_implemented` |
| `jsv run <file.jsv>` | Same stub as `check` |

Options:

- `--format text` (default) — one human-readable diagnostic line per issue (includes the code)
- `--format json` — single JSON object `{ "ok": boolean, "diagnostics": Diagnostic[] }` on stdout

Diagnostics always go to stdout. Parser, typechecker, DOM runtime, WASM, and MCP are out of scope for this slice.
