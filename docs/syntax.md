# JSV2 syntax (implemented subset)

Semicolons are required. There is no automatic semicolon insertion.
Spans are 1-based and inclusive. Newlines are `\n` only; `\r` is whitespace.

## Lexical

- Whitespace, `//` line comments, and non-nested `/* */` block comments are skipped.
- Identifiers: `[A-Za-z_][A-Za-z0-9_]*`
- Reserved keywords (never identifiers):  
  `import export from default function let const type interface class if else while for return true false null undefined string number boolean void never unknown constructor as new typeof async await`
- Numbers: `0` or `[1-9][0-9]*`, optional fraction and exponent. Leading-dot forms and leading-zero forms like `01` are invalid.
- Strings: `'` / `"` with escapes `\\ \' \" \n \r \t` and `\u` + 4 hex digits.
- Templates: backticks with `${` expr `}`; escapes as above plus `` \` `` and `\$`. Nested templates inside `${}` are allowed.
- Operators/punctuators:  
  `( ) { } [ ] , ; : ? . ?. ?? => = == === != !== <= >= < > + - * / % ! || &&`  
  Lone `|` / `&` are not expression operators (`|` is only valid in types). `?.` and `??` are single tokens, distinct from `?` and `.`.

## Program

A program is a sequence of statements.

### Imports

```
import Local from "mod";
import { a, b as c } from "mod";
import Local, { a, b as c } from "mod";
```

Module specifier must be a string literal. No `import *` or `import type`.

A specifier is `jsv/dom`, a relative path ending in `.jsv`, an extensionless relative path (`./mod`, `./mod/index`), or a relative path whose extension is `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, or `.cjs` (rewritten to `.jsv`). Other specifiers are rejected. Resolution and the error text are in `docs/types.md`.

### Declarations

Declarations may be prefixed with `export`. `export default` is allowed on `function`, `class`, and `let`/`const` only.

- `let` / `const` Ident (`:` Type)? (`=` Expr)? `;`  
  `const` without `=` is a parse error (`jsv.parse.const_missing_init`).
- `async`? `function` Ident TypeParams? `(` ParamList `)` `:` Type Block  
  Return type is required. Params are `Ident` `?`? `: Type` (trailing commas ok). A type is still required on an optional parameter. Optional parameters must be a suffix (`jsv.parse.required_after_optional`).
- `type` Ident TypeParams? `=` Type `;`
- `interface` Ident TypeParams? `{` members `}`  
  Members: property `Ident` `?`? `: Type ;`, or method `Ident` `?`? TypeParams? `(` ParamList `)` `:` Type `;`.  
  The `?` comes before type parameters: `m?<T>(x: T): T`.
- `class` Ident `{` members `}`  
  Members: field `Ident` `?`? `: Type ;` (no initializers), `constructor` `(` ParamList `)` Block, or `async`? method with return type and body.  
  Optional methods (`m?(): R`, `m?<T>(): R`) are a parse error (`jsv.parse.unsupported`). No `extends`, `implements`, or access modifiers.

`TypeParams` = `<` Ident (`,` Ident)* `,`? `>`

### Control flow

- `if ( Expr ) Statement ( else Statement )?`
- `while ( Expr ) Statement`
- `for ( ForInit ; Expr? ; Expr? ) Statement`  
  `ForInit` is empty, a `let`/`const` binding (no trailing `;` of its own), or an expression.
- `return` Expr? `;`
- Block `{` Statement* `}`
- Empty statement `;`
- Expression statement `Expr ;`

## Types

`Type` = union of primaries joined by `|`.

Primary forms:

- Primitives: `string number boolean null void never unknown undefined`
- Named type with optional type arguments: `Ident` `<` Type (`,` Type)* `,`? `>`?
- Postfix arrays: `T[]` (left-associative)
- Object types: `{` members with required `;` after each `}`
- Function types: `(` ParamList `)` `=>` Type
- Parentheses: `( Type )` (not a separate AST node)

## Expressions (low → high precedence)

1. Assignment `=` (right-associative; target must be ident, member, or index)
2. Ternary `? :` (right-associative)
3. `??` (left-associative)
4. `||`
5. `&&`
6. `== != === !==`
7. `< > <= >=`
8. `+ -`
9. `* / %`
10. Prefix unary `await` `!` `-` `typeof`
11. Postfix: call, `?.()`, `.` Ident, `?.` Ident, `[` Expr `]`, `?.[` Expr `]`, `as` Type  
    (`as` binds tighter than unary: `!x as T` is `!(x as T)`)
12. Primary: literals, ident, `( Expr )`, array/object literals, parenthesized arrow, `async` arrow, `new`

`??` cannot be mixed with `||` or `&&` unless one side is parenthesized (`jsv.parse.mixed_nullish`). `(a || b) ?? c` and `a ?? (b && c)` parse. `a ?? b || c` does not.

Optional chaining is `obj?.prop`, `obj?.[expr]`, `fn?.()`, `fn?.<T>(args)`, and the same forms after another postfix. `?.` must be followed by a property name, `[`, or `(` (`jsv.parse.optional_chain`). Parentheses close the chain: `(obj?.inner).n` is a property access on the chain result. `obj?.prop = v` and `(obj?.prop) = v` are parse errors (`jsv.parse.invalid_assignment_target`). `(obj?.inner).field = v` parses.

`await Expr` is a unary expression. It is only legal inside an `async` function, method, or arrow. `async` and `await` are always keywords, so `obj.await` is not a member access and a bare `async` value is `jsv.parse.unsupported`.

`async function` declarations (including `export` and `export default`) and `async` methods are supported. Async function expressions (`let f = async function () {}`) are not; use a declaration or `async (params) =>`.

Arrows are only `( ParamList ) =>` (Expr | Block), or `async` followed by that form. Params must be typed (`x?: T` allowed). `=> {` is always a block. A single parameter is still parenthesized in the source.

`new` takes a callee (ident / member chain / paren), optional type args, and a required argument list.

Generic calls: `id<Type>(args)` when `<...>` is followed by `(`. Otherwise `<` is relational. `id?.<Type>(args)` is an optional generic call.
