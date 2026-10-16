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
| `jsv.parse.unexpected_token` whose message includes `` expected `;` `` | Insert `;` at the diagnostic start when that token starts a line, is `}`, or is a statement keyword (`let`, `const`, `function`, `return`, `if`, `while`, `for`, `type`, `interface`, `class`, `import`, `export`, `else`). A token in the middle of a declaration is left alone |
| `jsv.parse.unexpected_token` with message `function return type is required` or `method return type is required` | Insert `: T ` before `{` when every valued `return` has the same simple type, or `: void ` when the body is empty or is only a bare `return;`. No edit when returns disagree, the body has statements and no `return`, or another parse error is inside the function or method |
| `jsv.check.missing_type_arguments` | Insert `<...>` after the callee or type name when every type parameter is inferred from the arguments or the initializer. No edit when a parameter is unconstrained, arguments disagree, or the shapes do not match |
| `jsv.check.unexpected_type_arguments` | Delete the `<...>` on that call or `new` |
| `jsv.check.unresolved_name` | One of: replace the identifier with the single in-scope binding at Damerau–Levenshtein distance 1 (value uses consider value bindings; type uses consider type bindings and primitive type names); insert or extend `import { … } from "jsv/dom"` when the name is exactly a `jsv/dom` export of the matching kind; or rename to the single `jsv/dom` export of that kind at distance 1 and import it when it is not already imported under that local. A DOM typo is considered only when both the written name and the export are at least 3 characters. An exact export plus any close in-scope or DOM name, two or more in-scope names at distance 1, or an existing import of that export under a different local produces no edit |
| `jsv.check.not_assignable`, `jsv.check.condition_not_boolean` | Append `.get()` when the expression is a `Signal` or `Computed` whose inner type is assignable to the expected type. Append `()` when the expression is an uncalled `.get`, or (except on the initializer of an annotated binding) another 0-argument function whose return type fits. Replace `unknown` with `expr as T` when `T` is not `unknown`. Convert a literal only when it is not the initializer of an annotated binding and the expected type has exactly one primitive (`Signal` and `Computed` members are skipped): a number becomes a quoted string of its source text, a boolean becomes `"true"` or `"false"` when that primitive is `string`, and a canonical numeric string becomes a number when that primitive is `number` |
| `jsv.check.bad_operator` | Wrap the unique operand or pair of operands with `.get()` or `()` that makes the operator legal. Two different minimum wraps produce no edit |
| `jsv.check.assign_const` | Replace `name = value` with `name.set(value)` when `name` is a writable `Signal` and `value` fits the inner type but not the signal. Otherwise, when `value` already fits and the file has exactly one `const` of that name textually before the assignment, change that `const` to `let` |
| `jsv.check.missing_property` | Replace the property with the single name in `Known properties:` at distance 1 |
| `jsv.check.missing_return` | Insert `return ` before the expression when the function or arrow body is a block with exactly one expression statement |
| `jsv.dom.effect_should_be_computed` | Replace the unique `signal<T>(...)` initializer of the written name with `computed<T>(() => { return expr; })` (importing `computed` when needed) and delete the effect statement. Applied only when the callback is exactly `target.set(expr)`, `expr` is built from `.get()` reads and does not mention `target`, the file has exactly one `.set` or `.update` of `target`, the signal declaration has explicit type arguments, and a recheck adds no diagnostic messages |

Mismatch, property, return, type-argument, const, and effect rewrites are kept only when a recheck does not add diagnostic messages and the count of that code drops. Semicolon, return-type, and import or rename edits are not gated that way.

`diagnostics` on a `jsv.dom.*` result are the checker diagnostics, not the DOM warnings. Read warnings from `domAnalyze`.

These stay `applicable: false`: `jsv.parse.const_missing_init`; a literal that initializes an annotated binding (`let x: string = 1`); a `Signal<number>` (or other inner type) that does not fit the expected type; assigning a value that does not fit a `const`'s type; assigning to a `Computed`; more than one `const` of the written name; and every DOM warning other than `jsv.dom.effect_should_be_computed`.

### `domAnalyze`

**Input:** `{ source?: string, path?: string }`

**Result:** `{ signals: Span[], effects: Span[], lists: Span[], issues: Diagnostic[], diagnostics: Diagnostic[] }`

Pure AST analysis of calls imported from `"jsv/dom"` (`signal`, `computed`, `effect`, `list`, including `as` renames). Does **not** load WASM or import the runtime graph/DOM modules.

`diagnostics` holds parser diagnostics from `parse()`, plus input failures (`jsv.mcp.missing_input` when both `source` and `path` are absent, `jsv.check.module_not_found` when `path` cannot be read). Parse errors do **not** suppress walking the partial AST: inventories and DOM `issues` are still collected from whatever program the parser returned. Parser diagnostics and input failures are never copied into `issues`. A clean file has `diagnostics: []`. `issues` holds only DOM warnings.

Issue codes (severity `warning`):

| Code | When |
|------|------|
| `jsv.dom.conditional_signal` | `signal()` / `computed()` directly nested in `if` / `while` / `for`. A nested function, method, or arrow clears the conditional, so a signal created inside that nested function is not flagged |
| `jsv.dom.signal_in_effect` | `signal()` / `computed()` directly inside an `effect` callback. Nested functions and arrows are not inside the effect for this check. An `if` inside the effect can also report `jsv.dom.conditional_signal` |
| `jsv.dom.effect_self_write` | Same identifier is both `.get()`-read and `.set()`/`.update()`-written inside one `effect` callback |
| `jsv.dom.effect_should_be_computed` | The effect callback is exactly `target.set(expr)`, `target` is not also read, `expr` reads at least one other signal with `.get()`, and every call in the body is a 0-argument `.get()` or that `target.set(...)`. `console.log` or any other call suppresses the warning |
| `jsv.dom.computed_writes` | A `computed` callback contains `.set` or `.update` |
| `jsv.dom.list_missing_key` | `list()` is called with fewer than three arguments |
| `jsv.dom.list_constant_key` | The key argument is a string literal, an arrow with no first parameter, or an arrow whose first parameter is never referenced. A non-arrow name is not flagged |
| `jsv.dom.list_unused_item` | `list` render callback’s first parameter is never referenced in the body |
