# MCP server

Stdio MCP server for JSV2 language intelligence. Not a full LSP; no completion tool.

## Run

```bash
node --experimental-strip-types src/mcp/server.ts
```

Server name `jsv2`, version `0.1.0`. Stdout is MCP protocol only; do not write logs to stdout. The process exits when the client closes stdin.

## Shared input

Tools that take source accept:

| Field | Type | Meaning |
|-------|------|---------|
| `source` | string (optional) | Inline `.jsv` source |
| `path` | string (optional) | Filesystem path; when non-empty, the file is read and `source` is ignored |

If neither is provided, the tool returns a result with `ok: false` / empty inventories and diagnostic `jsv.mcp.missing_input` (`Provide source or path.`). Missing `path` yields `jsv.check.module_not_found`. Source-only checks use file `"<stdin>.jsv"` and `readFile: () => null` so relative imports do not touch disk (`jsv/dom` remains ambient).

Tool handlers return JSON as text content: `{ content: [{ type: "text", text: JSON.stringify(result) }] }`.

## Tools

### `check`

**Input:** `{ source?: string, path?: string }`

**Result:** `{ ok: boolean, diagnostics: Diagnostic[] }`

`ok` is true iff `diagnostics` is empty. Reuses the checker (`checkFile` / `checkSource`).

### `typeOf`

**Input:** `{ source?: string, path?: string, line: number, column: number }`

`line` / `column` are 1-based; column counts UTF-16 code units.

**Result:**

```ts
{
  found: boolean,   // a type node was located (not “file is clean”)
  type?: string,
  start?: SourcePosition,
  end?: SourcePosition,
  diagnostics: Diagnostic[]
}
```

### `suggestFix`

**Input:** `{ source?: string, path?: string, code: string, line: number, column: number }`

**Result:** `{ applicable: boolean, edits: TextEdit[], message: string, diagnostics: Diagnostic[] }`

`TextEdit` is `{ start: SourcePosition, end: SourcePosition, newText: string }`. Edits are not applied on disk.

The only automatic edit: diagnostic `jsv.parse.unexpected_token` whose message includes `expected ';'`, matched at the given start line/column. Inserts `;` at that position (zero-width insert). Other codes (including `jsv.parse.const_missing_init`, `jsv.check.not_assignable`, `jsv.check.missing_type_arguments`) are not auto-fixable.

### `domAnalyze`

**Input:** `{ source?: string, path?: string }`

**Result:** `{ signals: Span[], effects: Span[], lists: Span[], issues: Diagnostic[], diagnostics: Diagnostic[] }`

Pure AST analysis of calls imported from `"jsv/dom"` (`signal`, `computed`, `effect`, `list`, including `as` renames). Does **not** load WASM or import the runtime graph/DOM modules.

`diagnostics` holds parser diagnostics from `parse()`. Parse errors do **not** suppress walking the partial AST: inventories and DOM `issues` are still collected from whatever program the parser returned. Parser diagnostics are never copied into `issues`. A clean file has `diagnostics: []`.

Issue codes (severity `warning`):

| Code | When |
|------|------|
| `jsv.dom.conditional_signal` | `signal()` / `computed()` nested in `if` / `while` / `for` |
| `jsv.dom.effect_self_write` | Same identifier is both `.get()`-read and `.set()`/`.update()`-written inside one `effect` callback |
| `jsv.dom.list_unused_item` | `list` render callback’s first parameter is never referenced in the body |
