import assert from "node:assert/strict";
import { test } from "node:test";
import { signal } from "../../src/runtime/graph.ts";
import {
  h,
  list,
  mount,
  renderToString,
  text,
  type MountNode,
  type MountParent,
} from "../../src/runtime/dom.ts";

type FakeEl = MountNode & {
  tag: string;
  attrs: Map<string, string>;
  listeners: Map<string, Set<(ev: { currentTarget: MountNode }) => void>>;
  textContentWrites: number;
  setAttributeCalls: number;
  _children: FakeEl[];
  _parent: FakeParent | null;
};

type FakeParent = MountParent & {
  _children: FakeEl[];
};

function createFakeParent(): FakeParent {
  const parent: FakeParent = {
    _children: [],
    appendChild(child: MountNode) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = parent;
      parent._children.push(c);
      if (!c.childNodes) c.childNodes = c._children;
    },
    removeChild(child: MountNode) {
      const c = child as FakeEl;
      const i = parent._children.indexOf(c);
      if (i >= 0) parent._children.splice(i, 1);
      c._parent = null;
    },
    insertBefore(child: MountNode, before: MountNode | null) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = parent;
      if (before === null) {
        parent._children.push(c);
      } else {
        const i = parent._children.indexOf(before as FakeEl);
        if (i < 0) parent._children.push(c);
        else parent._children.splice(i, 0, c);
      }
      if (!c.childNodes) c.childNodes = c._children;
    },
  };
  return parent;
}

function createElement(tag: string): FakeEl {
  const el: FakeEl = {
    tag,
    nodeType: 1,
    textContent: "",
    textContentWrites: 0,
    setAttributeCalls: 0,
    attrs: new Map(),
    listeners: new Map(),
    value: "",
    parentNode: null,
    _children: [],
    _parent: null,
    get childNodes() {
      return el._children;
    },
    setAttribute(name: string, value: string) {
      el.setAttributeCalls += 1;
      el.attrs.set(name, value);
    },
    removeAttribute(name: string) {
      el.attrs.delete(name);
    },
    addEventListener(type, handler) {
      let set = el.listeners.get(type);
      if (!set) {
        set = new Set();
        el.listeners.set(type, set);
      }
      set.add(handler);
    },
    removeEventListener(type, handler) {
      el.listeners.get(type)?.delete(handler);
    },
    appendChild(child: MountNode) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = el as unknown as FakeParent;
      c.parentNode = el as unknown as MountParent;
      el._children.push(c);
    },
    removeChild(child: MountNode) {
      const c = child as FakeEl;
      const i = el._children.indexOf(c);
      if (i >= 0) el._children.splice(i, 1);
      c._parent = null;
      c.parentNode = null;
    },
    insertBefore(child: MountNode, before: MountNode | null) {
      const c = child as FakeEl;
      if (c._parent) c._parent.removeChild(c);
      c._parent = el as unknown as FakeParent;
      c.parentNode = el as unknown as MountParent;
      if (before === null) {
        el._children.push(c);
      } else {
        const i = el._children.indexOf(before as FakeEl);
        if (i < 0) el._children.push(c);
        else el._children.splice(i, 0, c);
      }
    },
  };
  Object.defineProperty(el, "parentNode", {
    get() {
      return el._parent;
    },
    set(v: FakeParent | null) {
      el._parent = v;
    },
    configurable: true,
  });
  Object.defineProperty(el, "textContent", {
    get() {
      return (el as { _text?: string })._text ?? "";
    },
    set(v: string) {
      (el as { _text?: string })._text = v;
      el.textContentWrites += 1;
    },
    configurable: true,
  });
  return el;
}

function createText(value: string): FakeEl {
  const el = createElement("#text");
  el.nodeType = 3;
  el.textContent = value;
  el.textContentWrites = 0;
  return el;
}

test("renderToString escapes text and attributes", () => {
  assert.equal(
    renderToString(h("div", { id: "a" }, [text("hi<")])),
    '<div id="a">hi&lt;</div>',
  );
});

test("renderToString void tags have no close", () => {
  assert.equal(renderToString(h("input", { value: "x" }, [])), '<input value="x">');
});

test("signal text updates only that text node", () => {
  const parent = createFakeParent();
  const label = signal("a");
  const sibling = createElement("span");
  parent.appendChild(sibling);

  const dispose = mount(
    parent,
    h("div", {}, [text(label), text("static")]),
    createElement,
    createText,
  );

  const div = parent._children.find((c) => c.tag === "div")!;
  const textNodes = div._children.filter((c) => c.nodeType === 3);
  assert.ok(textNodes.length >= 2);
  const reactive = textNodes[0]!;
  const staticNode = textNodes[1]!;
  const writesBefore = reactive.textContentWrites;
  assert.equal(reactive.textContent, "a");

  label.set("b");
  assert.equal(reactive.textContent, "b");
  assert.equal(reactive.textContentWrites, writesBefore + 1);
  assert.equal(staticNode.textContent, "static");
  assert.equal(div._children[0], reactive);
  assert.equal(div._children[1], staticNode);
  assert.equal(parent._children.includes(sibling), true);

  dispose();
});

test("keyed list reorders, removes, and updates item signals", () => {
  type Item = { id: string; label: string };
  const items = signal<readonly Item[]>([
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
  ]);

  const parent = createFakeParent();
  const rowSignals = new Map<string, ReturnType<typeof signal<Item>>>();

  mount(
    parent,
    list(
      items,
      (item) => item.id,
      (itemSig) => {
        const id = itemSig.get().id;
        rowSignals.set(id, itemSig);
        return h("li", { id }, [text(itemSig.get().label)]);
      },
    ),
    createElement,
    createText,
  );

  const lis = () => parent._children.filter((c) => c.tag === "li");
  const initial = lis();
  assert.equal(initial.length, 3);
  const byId = new Map(initial.map((el) => [el.attrs.get("id")!, el]));
  assert.equal(byId.get("a")!.attrs.get("id"), "a");

  items.set([
    { id: "c", label: "C" },
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ]);
  const reordered = lis();
  assert.equal(reordered.length, 3);
  assert.equal(reordered[0], byId.get("c"));
  assert.equal(reordered[1], byId.get("a"));
  assert.equal(reordered[2], byId.get("b"));

  items.set([
    { id: "c", label: "C" },
    { id: "a", label: "A" },
  ]);
  const dropped = lis();
  assert.equal(dropped.length, 2);
  assert.equal(dropped[0], byId.get("c"));
  assert.equal(dropped[1], byId.get("a"));
  assert.equal(parent._children.includes(byId.get("b")!), false);

  const aSig = rowSignals.get("a")!;
  const before = aSig.get();
  items.set([
    { id: "c", label: "C" },
    { id: "a", label: "A2" },
  ]);
  assert.notEqual(aSig.get(), before);
  assert.equal(aSig.get().label, "A2");
  assert.equal(lis()[1], byId.get("a"));
});

test("onClick invokes handler", () => {
  const parent = createFakeParent();
  let clicks = 0;
  mount(
    parent,
    h("button", { onClick: () => { clicks += 1; } }, [text("go")]),
    createElement,
    createText,
  );
  const btn = parent._children.find((c) => c.tag === "button")!;
  const handlers = btn.listeners.get("click");
  assert.ok(handlers && handlers.size === 1);
  for (const hnd of handlers!) hnd({ currentTarget: btn });
  assert.equal(clicks, 1);
});

test("dispose unsubscribes further sets", () => {
  const parent = createFakeParent();
  const label = signal("x");
  const dispose = mount(parent, text(label), createElement, createText);
  const tn = parent._children.find((c) => c.nodeType === 3)!;
  const writes = tn.textContentWrites;
  dispose();
  label.set("y");
  assert.equal(tn.textContentWrites, writes);
  assert.equal(parent._children.includes(tn), false);
});
