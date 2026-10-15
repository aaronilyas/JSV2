# JSV2

JSV2 is a constrained TypeScript-like language aimed at agentic coding. It includes a fine-grained DOM/reactivity runtime so React is not used for ordinary UI, plus a hand-written lexer/parser, type checker, TypeScript build/check tooling, and a CLI (`jsv`). The signal graph, keyed list diff, and XML escape run in a Go/WASM module loaded once by JS. An MCP server is planned but not implemented yet.

## Requirements

- Node.js v23.5.0+ (CLI runs with `node --experimental-strip-types`)
- Go 1.22+ (for `make wasm` / `make test`)

## Setup

```bash
npm install
```

## Make targets

| Target | What it does |
|--------|----------------|
| `make check` | `tsc --noEmit` (strict typecheck) |
| `make wasm` | Build `runtime/wasm/jsv.wasm` and copy `wasm_exec.js` |
| `make test` | `make wasm`, Go unit tests, then `node --experimental-strip-types --test` on `tests/*.ts`, `tests/parser/*.ts`, `tests/checker/*.ts`, and `tests/runtime/*.ts` |
| `make build` | Compile TypeScript to `dist/` with `tsc` |

`make build` assumes dependencies are already installed. `make test` builds the WASM module first.

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

Diagnostics always go to stdout. See [docs/syntax.md](docs/syntax.md) for the language subset and [docs/types.md](docs/types.md) for typechecker rules.

## DOM

React is not used. Components are functions that return nodes; updates are per text/attribute/keyed list. Import from `jsv/dom` in `.jsv` sources. See [docs/dom.md](docs/dom.md).
