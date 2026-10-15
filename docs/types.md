# JSV2 types (non-obvious rules)

Boolean conditions only: `if` / `while` / `for` tests, ternary tests, `!`, `&&`, and `||` require `boolean`. `&&` / `||` always yield `boolean` (not an operand value).

No generic inference. Calls to generic functions and references to generic interfaces/aliases need explicit type arguments (`id<number>(1)`, `Box<string>`). Count must match.

Narrowing applies only to identifiers (not members):

- `===` / `!==` / `==` / `!=` against `null`, `undefined`, `true`, or `false`
- `typeof x === "string" | "number" | "boolean" | "undefined"` (and `!==`)

True branch of `if` / ternary consequent get the true narrow; else / alternate get the false narrow. `if (a && b)` where both sides are narrowing tests applies both in the consequent only. `while` narrows the body, not code after the loop.

Imports resolve relative to the importing file, plus the ambient module `jsv/dom` (no filesystem read). Cycles emit `import_cycle` and do not recurse. Parse errors in an import are reported; that module contributes no exports.

Relative candidates, in order, first existing file wins:

- `./x.jsv` and `../x.jsv` stay as written
- `./x.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs` (and `../` forms) rewrite the extension to `.jsv`
- extensionless `./x` tries `./x.jsv`, then `./x/index.jsv`

A missing `.jsv` specifier says `Module not found: './x.jsv'.`. A rewritten miss says which candidates were tried (`Looked for './x.jsv' or './x/index.jsv'.`). A bare specifier (`react`) says bare specifiers are not supported. Any other extension says only `.jsv` modules can be imported. The code is `jsv.check.module_not_found`. The same candidates are used when emitting imports, so `./x.js` and `./x` load the module that typechecked.

`console` is an ambient global with `log` / `error` (any arity, args `unknown`, return `void`). A module-level binding may shadow it.

`export` + `defaultExport` means default export only: the local name is in scope but is not a named export. `import { a }` needs a named export; `import D from` needs a default export.

`this` has the instance type only inside class constructors and methods. Arrows and nested functions do not receive `this`. Outside those bodies, `this` is unresolved.

## Nullish coalescing

`??` is not a boolean operator and does not narrow. `null` and `undefined` are stripped from the left operand:

- nothing stripped: the result is the left type (`string ?? number` is `string`; `unknown ?? T` is `unknown`)
- only nullish left: the result is the right type (`null ?? T` is `T`)
- otherwise the result is the non-nullish left, or its union with the right when those types differ (`string | null ?? string` is `string`; `string | null ?? number` is `string | number`)

## Optional properties, parameters, and chaining

An optional property `a?: T` may be missing on an object literal. Reading it yields `T | undefined`. Writing it accepts `T | undefined`. A required property is not satisfied by an optional one. The same rules apply to optional class fields (`name?: T` on the instance type). An optional method (`m?(): R`, including `m?<T>(...): R`) has type `F | undefined` and is not callable with a plain call.

An optional parameter `x?: T` is stored as optional on the function type and bound in the body as `T | undefined`. Calls may omit a trailing optional suffix. The arity error says `Expected N argument(s)` when the minimum and maximum match, and `Expected min to max argument(s)` otherwise. Passing `undefined` is allowed. Function assignability still requires the same parameter count. If the target parameter is optional, the source parameter must be optional too. The compared types include `| undefined` when the parameter is optional. `(x?: number) => void` is assignable to `(x: number) => void`. The reverse is not.

Optional chaining always adds `| undefined` to the result of the open chain, including when the receiver is not nullish. A following `.`, `[]`, or `()` continues from the non-nullish type, and that result still includes `| undefined` while the chain is open. `obj?.method()` calls the method type and the call result includes `| undefined`. `fn?.()` and `obj.method?.()` remove `null` and `undefined` from the callee before the call; the result includes `| undefined`. Parentheses close the chain, so `(obj?.inner).n` looks up `n` on a type that includes `undefined`.

## Async and `Promise<T>`

`Promise` is an ambient type-only name. `Promise<T>` needs an explicit type argument. It is not a value: there is no `Promise` constructor and no `.then`. A user-declared `Promise` shadows the ambient one and is not treated as a promise.

`async function` and `async` methods must annotate a return type that unwraps to `Promise<T>` (`jsv.check.async_return` otherwise). The function's type keeps that `Promise<T>`. A returned expression must be assignable to `T` or to `Promise<T>`. A bare `return;` is allowed when `T` is `void` or `undefined`. Falling off the end is checked against `T`, so `void` and `never` may fall off and other `T` may not.

`await` is `jsv.check.await_outside_async` outside an async function, method, or arrow. Nested non-async functions, arrows, and constructors are not async. `await` unwraps nested promises (`Promise<Promise<T>>` becomes `T`) and leaves non-promises unchanged. Union members are unwrapped separately. There is no top-level await.

An async arrow with an expression body and no expected function type has return type `Promise<Awaited<body>>`. A block body is `Promise<void>` unless the arrow is checked against an expected function type whose return type is `Promise<T>`. Sync arrows are unchanged: a block body is `void` unless an expected function type provides the return type.
