# JSV2 DOM / reactivity

Import from the ambient specifier `jsv/dom` (checker) or `src/runtime` (TypeScript host).

Components are plain functions that return a `Node`. There is no component class, no JSX, and no whole-tree virtual DOM diff on every event. Updates are fine-grained: one text node, one attribute, or a keyed list row.

## API

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

## Mount and SSR

`mount` never touches global `document`. Callers pass factories (`document.createElement` / `createTextNode` in the browser; fakes in tests). The returned dispose removes mounted nodes and subscriptions.

`renderToString` reads current signal values for backend HTML. It escapes `& < > "` in text and attributes, omits event handlers, and serializes void tags without a close tag.

## Updates

- Signal/computed text updates that text node's `textContent` only.
- Signal/computed props update that attribute only (`setAttribute`).
- `list` reconciles by key: same key keeps the DOM node and `set`s the row item signal; new keys mount; missing keys unmount; order follows the array via `insertBefore`.

The signal graph, keyed list diff, and XML escape run in a Go WASM module (`runtime/go/` → `runtime/wasm/jsv.wasm`), loaded once by JS. DOM node creation, event listeners, and `insertBefore` stay in JS; `mount` applies patches in JS.
