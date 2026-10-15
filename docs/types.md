# JSV2 types (non-obvious rules)

Boolean conditions only: `if` / `while` / `for` tests, ternary tests, `!`, `&&`, and `||` require `boolean`. `&&` / `||` always yield `boolean` (not an operand value).

No generic inference. Calls to generic functions and references to generic interfaces/aliases need explicit type arguments (`id<number>(1)`, `Box<string>`). Count must match.

Narrowing applies only to identifiers (not members):

- `===` / `!==` / `==` / `!=` against `null`, `undefined`, `true`, or `false`
- `typeof x === "string" | "number" | "boolean" | "undefined"` (and `!==`)

True branch of `if` / ternary consequent get the true narrow; else / alternate get the false narrow. `if (a && b)` where both sides are narrowing tests applies both in the consequent only. `while` narrows the body, not code after the loop.

Imports: only `./` or `../` specifiers ending in `.jsv`, resolved with `path.resolve(dirname(file), specifier)`, plus the ambient module `jsv/dom` (no filesystem read). Anything else is `module_not_found`. Cycles emit `import_cycle` and do not recurse. Parse errors in an import are reported; that module contributes no exports.

`console` is an ambient global with `log` / `error` (any arity, args `unknown`, return `void`). A module-level binding may shadow it.

`export` + `defaultExport` means default export only: the local name is in scope but is not a named export. `import { a }` needs a named export; `import D from` needs a default export.

`this` has the instance type only inside class constructors and methods. Arrows and nested functions do not receive `this`. Outside those bodies, `this` is unresolved.
