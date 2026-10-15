# JSV2 DOM / reactivity

Import from the ambient specifier `jsv/dom` (checker) or `src/runtime` (TypeScript host).

Components are plain functions that return a `Node`. There is no component class and no whole-tree virtual DOM diff on every event. Updates are fine-grained: one text node, one attribute, or a keyed list row.

`.jsv` programs may import values `signal`, `computed`, `effect`, `text`, `h`, `fragment`, `list`, and `renderToString` from `jsv/dom`. Types `Node`, `Signal`, `Computed`, and `DomProps` are type-only. `mount` is a host API (TypeScript / tests), not part of the `.jsv` surface.

JSX is syntax, not a runtime. It lowers to `h`, `text`, `fragment`, `list`, and the host helper `jsxChild`. A file that uses JSX does not import those names; the emitter adds them.

## JSX

```jsv
import { signal, computed, Node } from "jsv/dom";

export function Counter(): Node {
  let n = signal<number>(0);
  let label = computed<string>(() => {
    return "count " + n.get();
  });
  return <button onClick={() => { n.update((v: number) => { return v + 1; }); }}>
    {label}
  </button>;
}
```

Tags in expression position:

| Form | Lowers to |
|------|-----------|
| `<div id="a">{child}</div>` | `h("div", { id: "a" }, [children])` |
| `<br />` | `h("br", {}, [])` |
| `<>...</>` | `fragment([...])` |
| `<Counter />` | `Counter()` when the function takes no arguments |
| `<Card title={t}>{body}</Card>` | `Card({ title: t, children: [...] })` |
| `<each items={rows} key={k}>{render}</each>` | `list(rows, k, render)` |

A tag whose name starts with an uppercase letter is a component call. Any other tag is an intrinsic element, except `each`.

`signal` and `computed` still need explicit type arguments. `<each>` infers `T` from `items`.

### Children

- Text is kept as written when the chunk has no newline. A chunk that contains a newline is trimmed, and internal line breaks collapse to one space. A whitespace-only chunk is dropped, so indentation between tags does not create text nodes. Force a space with `{" "}`.
- `{expr}` accepts a `Node`, a `Node[]`, or `string | Signal<string> | Computed<string>`. Strings and string signals become a `text` node, so `{label}` updates that node only. `Node[]` becomes a fragment.
- `{n.get()}` reads once. It is not a subscription. Dynamic text has to be a string, a `Signal<string>`, or a `Computed<string>`.
- `{/* comment */}` is a comment. `//` inside text is text.
- A `<` in text starts a tag. Write `{"a < b"}` for a less-than character.

`<` starts JSX only at the beginning of an expression. `a < b` is still a comparison, and `id<number>(1)` is still a generic call.

### Attributes

Intrinsic attributes are `id`, `class` or `className` (the same attribute; `class` is emitted as `className`), `value`, `onClick`, and `onInput`. Values are `"strings"` or `{expr}`. Unknown attributes and valueless attributes are errors. Event handlers are omitted from `renderToString`.

Void tags (`area`, `base`, `br`, `col`, `embed`, `hr`, `img`, `input`, `link`, `meta`, `source`, `track`, `wbr`) cannot have children.

### Components

- `<Foo />` calls a zero-argument function.
- A function with one object argument is called with that object. Children are the `children` property and their type is `Node[]`.
- Required props must be present. A props function with no attributes and no children is an error; call it directly if every prop is optional and there are no children.
- Generic functions are not tags. Call them with type arguments.

### `<each>`

Keyed lists stay on `list`. The tag is not an HTML element:

```jsv
<ul>
  <each items={rows} key={(row: Row) => row.id}>
    {(row: Signal<Row>) => {
      let label = computed<string>(() => { return row.get().label; });
      return <li>{label}</li>;
    }}
  </each>
</ul>
```

`items` is `Signal<T[]>` or `Computed<T[]>`. `key` is `(item: T) => string`. The only child is `(item: Signal<T>) => Node`. The callback receives a signal, not `T`. A `computed` created in that callback subscribes to the row signal, so a later `set` of the same key updates the text node. Reading `row.get()` into a plain string does not.

## Lower-level API

The calls JSX lowers to are still valid and typecheck the same way:

```ts
signal<T>(initial: T): Signal<T>
computed<T>(fn: () => T): Computed<T>
effect(fn: () => void | (() => void)): () => void

text(value: string | Signal<string> | Computed<string>): Node
h(tag: string, props: DomProps, children: readonly Node[]): Node
fragment(children: readonly Node[]): Node
list<T>(
  items: Signal<readonly T[]> | Computed<readonly T[]>,
  key: (item: T) => string,
  render: (item: Signal<T>) => Node,
): Node

mount(
  parent: MountParent,
  node: Node,
  createElement: (tag: string) => MountNode,
  createText: (value: string) => MountNode,
): () => void

renderToString(node: Node): string
```

`DomProps`: optional `id`, `className`, `value` (string or readable); `onClick`; `onInput(value: string)`. `className` maps to the HTML `class` attribute.

`jsxChild` is not part of the `.jsv` surface. The emitter imports it from the runtime to coerce `{expr}` children. It returns a node unchanged, wraps a `Node[]` in a fragment, and wraps a string or string signal in `text`.

## Mount and SSR

`mount` never touches global `document`. Callers pass factories (`document.createElement` / `createTextNode` in the browser; fakes in tests). The returned dispose removes mounted nodes and subscriptions.

`renderToString` reads current signal values for backend HTML. It escapes `& < > "` in text and attributes, omits event handlers, and serializes void tags without a close tag.

## Updates

- Signal/computed text updates that text node's `textContent` only.
- Signal/computed props update that attribute only (`setAttribute`).
- `list` (including `<each>`) reconciles by key: same key keeps the DOM node and `set`s the row item signal; new keys mount; missing keys unmount; order follows the array via `insertBefore`.

The signal graph, keyed list diff, and XML escape run in a Go WASM module (`runtime/go/` → `runtime/wasm/jsv.wasm`), loaded once by JS. DOM node creation, event listeners, and `insertBefore` stay in JS; `mount` applies patches in JS.

Effects that subscribe to the same signal run in subscription order. A thrown effect or computed callback is rethrown to the caller; the graph keeps accepting later updates. `effect`'s dispose function releases that effect's node. Signal and computed objects are tracked with `FinalizationRegistry`, so a node that the page no longer holds and that no effect still reads can be freed.

### Browser and Node

`src/runtime/wasm-load.ts` picks one loader:

- Node uses `src/runtime/wasm-load-node.ts` (filesystem). This is the backend and test path.
- Otherwise `src/runtime/wasm-browser.ts` fetches `wasm_exec.js` and the `.wasm` module (`fetch` + `WebAssembly.instantiateStreaming`). It does not use Node built-ins.

Both paths keep a single instance and do not spawn a Go process. If the files are not served next to the module URL `../../runtime/wasm/`, set `globalThis.__jsvWasmAssets` to `{ wasmURL, execURL }` before the first import. The wasm response should use `Content-Type: application/wasm`; any other type falls back to `WebAssembly.instantiate`.
