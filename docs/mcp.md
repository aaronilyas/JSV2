# MCP server

Stdio MCP server for JSV2 language intelligence. Agent-oriented tools (including completions), not a full LSP.

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

### `complete`

**Input:** `{ source?: string, path?: string, line: number, column: number }`

`line` / `column` are 1-based; column counts UTF-16 code units and points at a character (the same coordinates as `typeOf`). The prefix is the identifier text from the token start through that character. A non-identifier character (a `.`, or whitespace) has an empty prefix, so every candidate in that context is returned.

**Result:**

```ts
{
  prefix: string,
  replace: { start: SourcePosition, end: SourcePosition }, // half-open [start, end)
  candidates: {
    name: string,
    kind: "local" | "param" | "import" | "declaration" | "ambient" | "member" | "module-export",
    bindingKind: "value" | "type" | "both",
    type: string,
    optional?: boolean
  }[],
  diagnostics: Diagnostic[]
}
```

Contexts, in order:

| Cursor | Candidates |
|--------|------------|
| Inside `{ … }` of `import … from "jsv/dom"` (the imported name, not the local after `as`) | `jsv/dom` value and type exports (`kind: "module-export"`) |
| On `.` or on the property of a member expression | Properties of the receiver’s checked type (`kind: "member"`), including `Signal` `get` / `set` / `update`, `Computed` `get`, and object or class members. `optional` is the declared optional flag; `type` is the declared property type. A union contributes only properties shared with the same type. Parse errors do not suppress this: the checker still types the partial program |
| Anywhere else an identifier can appear | In-scope bindings: `local`, `param` (including type parameters), `import`, top-level `declaration`, and the ambient `console` |

Other import statements yield no candidates. Names are filtered with `startsWith(prefix)` and sorted by name.

### `suggestFix`

**Input:** `{ source?: string, path?: string, code: string, line: number, column: number }`

**Result:** `{ applicable: boolean, edits: TextEdit[], message: string, diagnostics: Diagnostic[] }`

`TextEdit` is `{ start: SourcePosition, end: SourcePosition, newText: string }`. Edits are not applied on disk.

`TextEdit` replaces the half-open range `[start, end)`. `start === end` inserts `newText` at that caret. Edits are not applied on disk.

Fixes are conservative. `applicable` is false when the code is not fixable, the diagnostic is not at that position, or more than one edit would be reasonable.

| Diagnostic | Edit |
|------------|------|
| `jsv.parse.unexpected_token` whose message includes `expected ';'` | Insert `;` at the diagnostic start |
| `jsv.check.missing_type_arguments` | Insert `<...>` after the callee or type name when every type parameter is inferred from the arguments or the initializer. No edit when a parameter is unconstrained, arguments disagree, or the shapes do not match |
| `jsv.check.unresolved_name` | Replace the identifier with the single in-scope binding at Damerau–Levenshtein distance 1 (value uses consider value bindings; type uses consider type bindings and primitive type names), **or** insert/extend an `import { … } from "jsv/dom"` when the name is exactly a `jsv/dom` export of the matching kind |

A missing `const` initializer (`jsv.parse.const_missing_init`), `jsv.check.not_assignable`, and any unresolved name that is both a close in-scope typo and a `jsv/dom` export are not auto-fixable.

### `domAnalyze`

**Input:** `{ source?: string, path?: string }`

**Result:** `{ signals: Span[], effects: Span[], lists: Span[], issues: Diagnostic[], diagnostics: Diagnostic[] }`

Pure AST analysis of calls imported from `"jsv/dom"` (`signal`, `computed`, `effect`, `list`, including `as` renames). Does **not** load WASM or import the runtime graph/DOM modules.

`diagnostics` holds parser diagnostics from `parse()`, plus input failures (`jsv.mcp.missing_input` when both `source` and `path` are absent, `jsv.check.module_not_found` when `path` cannot be read). Parse errors do **not** suppress walking the partial AST: inventories and DOM `issues` are still collected from whatever program the parser returned. Parser diagnostics and input failures are never copied into `issues`. A clean file has `diagnostics: []`. `issues` holds only DOM warnings.

Issue codes (severity `warning`):

| Code | When |
|------|------|
| `jsv.dom.conditional_signal` | `signal()` / `computed()` nested in `if` / `while` / `for` |
| `jsv.dom.effect_self_write` | Same identifier is both `.get()`-read and `.set()`/`.update()`-written inside one `effect` callback |
| `jsv.dom.list_unused_item` | `list` render callback’s first parameter is never referenced in the body |
