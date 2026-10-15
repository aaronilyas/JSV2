import { effect, signal, type Computed, type Signal } from "./graph.ts";
import { reconcile, type KeyedEntry } from "./reconcile.ts";

export type Node = {
  readonly nodeKind: "text" | "element" | "fragment" | "list";
};

export type DomProps = {
  id?: string | Signal<string> | Computed<string>;
  className?: string | Signal<string> | Computed<string>;
  value?: string | Signal<string> | Computed<string>;
  onClick?: () => void;
  onInput?: (value: string) => void;
};

type TextNode = Node & {
  nodeKind: "text";
  value: string | Signal<string> | Computed<string>;
};

type ElementNode = Node & {
  nodeKind: "element";
  tag: string;
  props: DomProps;
  children: readonly Node[];
};

type FragmentNode = Node & {
  nodeKind: "fragment";
  children: readonly Node[];
};

type ListNode = Node & {
  nodeKind: "list";
  items: Signal<readonly unknown[]> | Computed<readonly unknown[]>;
  key: (item: unknown) => string;
  render: (item: Signal<unknown>) => Node;
};

export type MountParent = {
  appendChild(child: MountNode): void;
  removeChild(child: MountNode): void;
  insertBefore(child: MountNode, before: MountNode | null): void;
};

export type MountNode = {
  nodeType: number;
  textContent: string;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(
    type: string,
    handler: (ev: { currentTarget: MountNode }) => void,
  ): void;
  removeEventListener(
    type: string,
    handler: (ev: { currentTarget: MountNode }) => void,
  ): void;
  value?: string;
  parentNode: MountParent | null;
  childNodes?: MountNode[];
  appendChild(child: MountNode): void;
  removeChild(child: MountNode): void;
  insertBefore(child: MountNode, before: MountNode | null): void;
};

type Disposer = () => void;

type Mounted = {
  roots: MountNode[];
  dispose: Disposer;
};

type MountContext = {
  createElement: (tag: string) => MountNode;
  createText: (value: string) => MountNode;
};

type ListRow = KeyedEntry<unknown> & {
  itemSignal: Signal<unknown>;
  roots: MountNode[];
  dispose: Disposer;
};

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

function isReadable(
  value: unknown,
): value is Signal<string> | Computed<string> {
  return (
    typeof value === "object" &&
    value !== null &&
    "get" in value &&
    typeof (value as { get: unknown }).get === "function"
  );
}

function readString(
  value: string | Signal<string> | Computed<string>,
): string {
  return isReadable(value) ? value.get() : value;
}

export function text(
  value: string | Signal<string> | Computed<string>,
): Node {
  const node: TextNode = { nodeKind: "text", value };
  return node;
}

export function h(
  tag: string,
  props: DomProps,
  children: readonly Node[],
): Node {
  const node: ElementNode = { nodeKind: "element", tag, props, children };
  return node;
}

export function fragment(children: readonly Node[]): Node {
  const node: FragmentNode = { nodeKind: "fragment", children };
  return node;
}

export function list<T>(
  items: Signal<readonly T[]> | Computed<readonly T[]>,
  key: (item: T) => string,
  render: (item: Signal<T>) => Node,
): Node {
  const node: ListNode = {
    nodeKind: "list",
    items: items as Signal<readonly unknown[]> | Computed<readonly unknown[]>,
    key: key as (item: unknown) => string,
    render: render as (item: Signal<unknown>) => Node,
  };
  return node;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function serializeProps(props: DomProps): string {
  let out = "";
  if (props.id !== undefined) {
    out += ` id="${escapeXml(readString(props.id))}"`;
  }
  if (props.className !== undefined) {
    out += ` class="${escapeXml(readString(props.className))}"`;
  }
  if (props.value !== undefined) {
    out += ` value="${escapeXml(readString(props.value))}"`;
  }
  return out;
}

export function renderToString(node: Node): string {
  switch (node.nodeKind) {
    case "text":
      return escapeXml(readString((node as TextNode).value));
    case "element": {
      const el = node as ElementNode;
      const attrs = serializeProps(el.props);
      if (VOID_TAGS.has(el.tag)) {
        return `<${el.tag}${attrs}>`;
      }
      return `<${el.tag}${attrs}>${el.children.map(renderToString).join("")}</${el.tag}>`;
    }
    case "fragment":
      return (node as FragmentNode).children.map(renderToString).join("");
    case "list": {
      const l = node as ListNode;
      return l.items
        .get()
        .map((item) => renderToString(l.render(signal(item))))
        .join("");
    }
    default: {
      const _exhaustive: never = node.nodeKind;
      return _exhaustive;
    }
  }
}

function removeFromParent(parent: MountParent, child: MountNode): void {
  if (child.parentNode !== null) {
    child.parentNode.removeChild(child);
    return;
  }
  try {
    parent.removeChild(child);
  } catch {
    // already detached
  }
}

function bindAttr(
  el: MountNode,
  attrName: string,
  value: string | Signal<string> | Computed<string> | undefined,
  disposers: Disposer[],
  asValueProp: boolean,
): void {
  if (value === undefined) return;
  if (!isReadable(value)) {
    if (asValueProp) el.value = value;
    el.setAttribute(attrName, value);
    return;
  }
  disposers.push(
    effect(() => {
      const v = value.get();
      if (asValueProp) el.value = v;
      el.setAttribute(attrName, v);
    }),
  );
}

function mountChildren(
  parent: MountParent,
  children: readonly Node[],
  ctx: MountContext,
  before: MountNode | null,
): Mounted {
  const roots: MountNode[] = [];
  const disposers: Disposer[] = [];
  for (const child of children) {
    const m = mountNode(parent, child, ctx, before);
    roots.push(...m.roots);
    disposers.push(m.dispose);
  }
  return {
    roots,
    dispose: () => {
      for (const d of disposers) d();
    },
  };
}

function mountText(
  parent: MountParent,
  node: TextNode,
  ctx: MountContext,
  before: MountNode | null,
): Mounted {
  const disposers: Disposer[] = [];
  const initial = isReadable(node.value) ? "" : node.value;
  const textNode = ctx.createText(initial);
  if (before !== null) parent.insertBefore(textNode, before);
  else parent.appendChild(textNode);

  if (isReadable(node.value)) {
    const readable = node.value;
    disposers.push(
      effect(() => {
        textNode.textContent = readable.get();
      }),
    );
  }

  return {
    roots: [textNode],
    dispose: () => {
      for (const d of disposers) d();
      removeFromParent(parent, textNode);
    },
  };
}

function mountElement(
  parent: MountParent,
  node: ElementNode,
  ctx: MountContext,
  before: MountNode | null,
): Mounted {
  const disposers: Disposer[] = [];
  const el = ctx.createElement(node.tag);
  if (before !== null) parent.insertBefore(el, before);
  else parent.appendChild(el);

  bindAttr(el, "id", node.props.id, disposers, false);
  bindAttr(el, "class", node.props.className, disposers, false);
  bindAttr(el, "value", node.props.value, disposers, true);

  if (node.props.onClick !== undefined) {
    const onClick = node.props.onClick;
    const handler = (_ev: { currentTarget: MountNode }) => {
      onClick();
    };
    el.addEventListener("click", handler);
    disposers.push(() => el.removeEventListener("click", handler));
  }

  if (node.props.onInput !== undefined) {
    const onInput = node.props.onInput;
    const handler = (ev: { currentTarget: MountNode }) => {
      const v = ev.currentTarget.value;
      onInput(v === undefined ? "" : v);
    };
    el.addEventListener("input", handler);
    disposers.push(() => el.removeEventListener("input", handler));
  }

  disposers.push(mountChildren(el, node.children, ctx, null).dispose);

  return {
    roots: [el],
    dispose: () => {
      for (const d of disposers) d();
      removeFromParent(parent, el);
    },
  };
}

function mountFragment(
  parent: MountParent,
  node: FragmentNode,
  ctx: MountContext,
  before: MountNode | null,
): Mounted {
  return mountChildren(parent, node.children, ctx, before);
}

function insertRoots(
  parent: MountParent,
  roots: readonly MountNode[],
  before: MountNode | null,
): void {
  for (const root of roots) {
    parent.insertBefore(root, before);
  }
}

function mountList(
  parent: MountParent,
  node: ListNode,
  ctx: MountContext,
  before: MountNode | null,
): Mounted {
  let rows: ListRow[] = [];
  // Trailing anchor so insertBefore has a stable end marker for this list.
  const anchor = ctx.createText("");
  if (before !== null) parent.insertBefore(anchor, before);
  else parent.appendChild(anchor);

  function sync(items: readonly unknown[]): void {
    const prevEntries: KeyedEntry<unknown>[] = rows.map((r) => ({
      key: r.key,
      item: r.item,
    }));
    const rowByKey = new Map<string, ListRow>();
    for (const r of rows) rowByKey.set(r.key, r);

    const { next, removed } = reconcile(prevEntries, items, node.key);

    for (const entry of removed) {
      const row = rowByKey.get(entry.key);
      if (row === undefined) continue;
      row.dispose();
      for (const root of row.roots) removeFromParent(parent, root);
      rowByKey.delete(entry.key);
    }

    const newRows: ListRow[] = [];
    for (let i = 0; i < next.length; i++) {
      const entry = next[i]!;
      const existing = rowByKey.get(entry.key);
      // Insertion point: first root among rows already committed after i,
      // else the list anchor. We place nodes one-by-one before the current
      // remainder's head, which starts as whatever still sits before anchor.
      const remainderHead = (): MountNode => {
        for (let j = i + 1; j < next.length; j++) {
          const later = rowByKey.get(next[j]!.key);
          if (
            later !== undefined &&
            later.roots.length > 0 &&
            !newRows.includes(later)
          ) {
            return later.roots[0]!;
          }
        }
        return anchor;
      };

      if (existing !== undefined) {
        existing.item = entry.item;
        existing.itemSignal.set(entry.item);
        const target = remainderHead();
        if (existing.roots.length > 0 && existing.roots[0] !== target) {
          insertRoots(parent, existing.roots, target);
        }
        newRows.push(existing);
      } else {
        const itemSignal = signal(entry.item);
        const child = node.render(itemSignal);
        const target = remainderHead();
        const mounted = mountNode(parent, child, ctx, target);
        const row: ListRow = {
          key: entry.key,
          item: entry.item,
          itemSignal,
          roots: mounted.roots,
          dispose: mounted.dispose,
        };
        rowByKey.set(entry.key, row);
        newRows.push(row);
      }
    }
    rows = newRows;
  }

  const disposeEffect = effect(() => {
    sync(node.items.get());
  });

  return {
    roots: [anchor],
    dispose: () => {
      disposeEffect();
      for (const row of rows) {
        row.dispose();
        for (const root of row.roots) removeFromParent(parent, root);
      }
      rows = [];
      removeFromParent(parent, anchor);
    },
  };
}

function mountNode(
  parent: MountParent,
  node: Node,
  ctx: MountContext,
  before: MountNode | null,
): Mounted {
  switch (node.nodeKind) {
    case "text":
      return mountText(parent, node as TextNode, ctx, before);
    case "element":
      return mountElement(parent, node as ElementNode, ctx, before);
    case "fragment":
      return mountFragment(parent, node as FragmentNode, ctx, before);
    case "list":
      return mountList(parent, node as ListNode, ctx, before);
    default: {
      const _exhaustive: never = node.nodeKind;
      return _exhaustive;
    }
  }
}

export function mount(
  parent: MountParent,
  node: Node,
  createElement: (tag: string) => MountNode,
  createText: (value: string) => MountNode,
): () => void {
  const mounted = mountNode(parent, node, { createElement, createText }, null);
  return () => {
    mounted.dispose();
  };
}
