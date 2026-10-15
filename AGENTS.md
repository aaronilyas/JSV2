# AGENTS.md

Non-obvious conventions for this repo. Prefer the smallest correct change.

## Commands

Use these exact targets (do not invent alternatives):

- `make build` — compile `src/` to `dist/` with `tsc` (deps must already be installed)
- `make check` — `tsc --noEmit`
- `make test` — `node --experimental-strip-types --test tests/**/*.ts`

## CLI

- Entry: `src/cli.ts` (tests spawn `node --experimental-strip-types src/cli.ts ...`)
- After build, `bin/jsv.js` imports `../dist/cli.js` and calls `main`
- Diagnostic JSON shape on stdout: `{ "ok": boolean, "diagnostics": Diagnostic[] }`
  - `ok` is true only when `diagnostics` is empty
  - `Diagnostic` is defined and exported from `src/diagnostics.ts`

## Layout

- Source: `src/`
- Tests: `tests/` (mirrors concerns; CLI coverage lives in `tests/cli.test.ts`)
- Do not edit `dist/` or `node_modules/`

## Later slices (do not implement here)

- Parser: `src/parser/`
- Checker: `src/checker/`
- DOM/reactivity: `src/runtime/`
- Go WASM: `runtime/go/` emitting `runtime/wasm/jsv.wasm`, loaded by JS (never spawn a Go process per call)
- MCP: `src/mcp/`

## Git

Commit/push rules from the global `AGENTS.md` still apply. Do not commit secrets or generated artifacts. Humans merge.
