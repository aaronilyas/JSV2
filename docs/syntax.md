# JSV2 syntax (implemented subset)

Semicolons are required. There is no automatic semicolon insertion.
Spans are 1-based and inclusive. Newlines are `\n` only; `\r` is whitespace.

## Lexical

- Whitespace, `//` line comments, and non-nested `/* */` block comments are skipped.
- Identifiers: `[A-Za-z_][A-Za-z0-9_]*`
- Reserved keywords (never identifiers):  
  `import export from default function let const type interface class if else while for return true false null undefined string number boolean void never unknown constructor as new typeof`
- Numbers: `0` or `[1-9][0-9]*`, optional fraction and exponent. Leading-dot forms and leading-zero forms like `01` are invalid.
- Strings: `'` / `"` with escapes `\\ \' \" \n \r \t` and `\u` + 4 hex digits.
- Templates: backticks with `${` expr `}`; escapes as above plus `` \` `` and `\$`. Nested templates inside `${}` are allowed.
- Operators/punctuators:  
  `( ) { } [ ] , ; : ? . => = == === != !== <= >= < > + - * / % ! || &&`  
  Lone `|` / `&` are not expression operators (`|` is only valid in types).

## Program

A program is a sequence of statements.

### Imports

```
import Local from "mod";
import { a, b as c } from "mod";
import Local, { a, b as c } from "mod";
```

Module specifier must be a string literal. No `import *` or `import type`.

### Declarations

Declarations may be prefixed with `export`. `export default` is allowed on `function`, `class`, and `let`/`const` only.

- `let` / `const` Ident (`:` Type)? (`=` Expr)? `;`  
  `const` without `=` is a parse error (`jsv.parse.const_missing_init`).
- `function` Ident TypeParams? `(` ParamList `)` `:` Type Block  
  Return type is required. Params are `Ident : Type` (trailing commas ok).
- `type` Ident TypeParams? `=` Type `;`
- `interface` Ident TypeParams? `{` members `}`  
  Members: property `Ident` `?`? `: Type ;` or method signature with params and return type.
- `class` Ident `{` members `}`  
  Members: field `Ident : Type ;` (no initializers), `constructor` `(` ParamList `)` Block, or method with return type and body.  
  No `extends`, `implements`, or access modifiers.

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
3. `||`
4. `&&`
5. `== != === !==`
6. `< > <= >=`
7. `+ -`
8. `* / %`
9. Prefix unary `!` `-` `typeof`
10. Postfix: call, `.` Ident, `[` Expr `]`, `as` Type  
    (`as` binds tighter than unary: `!x as T` is `!(x as T)`)
11. Primary: literals, ident, `( Expr )`, array/object literals, parenthesized arrow, `new`, JSX

## JSX

In primary position, `<` starts an element when the next token is an identifier, a keyword, or `>`.

```
<tag attr="string" attr={Expr} />
<tag attr={Expr}> JsxChild* </tag>
<> JsxChild* </>
```

`JsxChild` is text, `{ Expr }`, a nested element, or a fragment. `{/* comment */}` is a comment. A text chunk with no newline is kept as written. A chunk that contains a newline is trimmed and its line breaks collapse to a space. Whitespace-only chunks are dropped.

Closing tags must match. `/>` closes without children. Spread attributes are not supported. Attributes require a value.

`<` after an expression is still a comparison or a generic call (`id<number>(1)`), not JSX. See [dom.md](dom.md) for intrinsic tags, components, and `<each>`.

Arrows are only `( ParamList ) =>` (Expr | Block). Params must be typed. `=> {` is always a block.

`new` takes a callee (ident / member chain / paren), optional type args, and a required argument list.

Generic calls: `id<Type>(args)` when `<...>` is followed by `(`. Otherwise `<` is relational.
