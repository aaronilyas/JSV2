# `jsv run`

`jsv run <file.jsv>` typechecks the entry file and its import graph, transpiles the checked AST to plain ESM JavaScript, writes the modules to a temporary directory, and `import()`s the entry in the same Node process.

The emitted code imports the existing runtime (`src/runtime` / `dist/runtime`) for `jsv/dom`. That runtime loads the Go WASM module once via `ensureWasm()`; `jsv run` does not spawn a Go process per call.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Typecheck passed and the module finished without throwing |
| 1 | Missing/bad path, typecheck diagnostics, or a runtime throw (message on stderr) |

Diagnostics from a failed typecheck are printed the same way as `jsv check` (`--format text|json` on stdout). The program is not executed when typecheck fails.

## Backend vs host UI

- **Backend / SSR:** call `renderToString` from `jsv/dom` inside the `.jsv` program (see `examples/hello.jsv`).
- **Frontend host:** export a component function that returns a `Node` (see `examples/counter.jsv`). `mount` is not part of the `.jsv` surface; the host (tests or app code) imports the runtime and mounts the exported component with its own DOM factories.
