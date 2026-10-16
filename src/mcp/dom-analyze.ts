import type { Diagnostic } from "../diagnostics.ts";
import type {
  Block,
  Expr,
  FunctionDecl,
  Program,
  Span,
  Statement,
} from "../parser/ast.ts";
import { parse } from "../parser/parse.ts";

export function domAnalyze(
  source: string,
  file: string,
): {
  signals: Span[];
  effects: Span[];
  lists: Span[];
  issues: Diagnostic[];
  diagnostics: Diagnostic[];
} {
  const { program, diagnostics: parseDiags } = parse(source, file);

  const locals = resolveDomLocals(program);
  const signals: Span[] = [];
  const effects: Span[] = [];
  const lists: Span[] = [];
  const issues: Diagnostic[] = [];

  walkProgram(program, {
    inConditional: false,
    inEffect: false,
    locals,
    signals,
    effects,
    lists,
    issues,
    file,
  });

  return { signals, effects, lists, issues, diagnostics: parseDiags };
}

type DomLocals = {
  signal: Set<string>;
  computed: Set<string>;
  effect: Set<string>;
  list: Set<string>;
};

type WalkState = {
  inConditional: boolean;
  /** True only while walking an effect callback body (not nested functions). */
  inEffect: boolean;
  locals: DomLocals;
  signals: Span[];
  effects: Span[];
  lists: Span[];
  issues: Diagnostic[];
  file: string;
};

function resolveDomLocals(program: Program): DomLocals {
  const locals: DomLocals = {
    signal: new Set(),
    computed: new Set(),
    effect: new Set(),
    list: new Set(),
  };
  for (const stmt of program.body) {
    if (stmt.kind !== "import") continue;
    if (stmt.moduleSpecifier !== "jsv/dom") continue;
    for (const n of stmt.names) {
      if (n.imported === "signal") locals.signal.add(n.local);
      else if (n.imported === "computed") locals.computed.add(n.local);
      else if (n.imported === "effect") locals.effect.add(n.local);
      else if (n.imported === "list") locals.list.add(n.local);
    }
  }
  return locals;
}

function walkProgram(program: Program, state: WalkState): void {
  for (const stmt of program.body) {
    walkStatement(stmt, state);
  }
}

function walkStatement(stmt: Statement, state: WalkState): void {
  switch (stmt.kind) {
    case "import":
    case "empty":
    case "type_alias":
    case "interface":
      return;
    case "var":
      if (stmt.init !== null) walkExpr(stmt.init, state);
      return;
    case "function":
      walkFunctionBody(stmt, state);
      return;
    case "class":
      for (const m of stmt.members) {
        if (m.kind === "constructor" || m.kind === "method") {
          walkBlock(m.body, { ...state, inConditional: false, inEffect: false });
        }
      }
      return;
    case "if": {
      const nested = { ...state, inConditional: true };
      walkExpr(stmt.test, nested);
      walkStatement(stmt.consequent, nested);
      if (stmt.alternate !== null) walkStatement(stmt.alternate, nested);
      return;
    }
    case "while": {
      const nested = { ...state, inConditional: true };
      walkExpr(stmt.test, nested);
      walkStatement(stmt.body, nested);
      return;
    }
    case "for": {
      const nested = { ...state, inConditional: true };
      if (stmt.init !== null) {
        if (stmt.init.kind === "var") {
          if (stmt.init.init !== null) walkExpr(stmt.init.init, nested);
        } else {
          walkExpr(stmt.init, nested);
        }
      }
      if (stmt.test !== null) walkExpr(stmt.test, nested);
      if (stmt.update !== null) walkExpr(stmt.update, nested);
      walkStatement(stmt.body, nested);
      return;
    }
    case "return":
      if (stmt.argument !== null) walkExpr(stmt.argument, state);
      return;
    case "block":
      walkBlock(stmt, state);
      return;
    case "expr_stmt":
      walkExpr(stmt.expression, state);
      return;
    default: {
      const _exhaustive: never = stmt;
      return _exhaustive;
    }
  }
}

function walkFunctionBody(fn: FunctionDecl, state: WalkState): void {
  // Nested functions run later, so they are not conditional or effect context.
  walkBlock(fn.body, { ...state, inConditional: false, inEffect: false });
}

function walkBlock(block: Block, state: WalkState): void {
  for (const stmt of block.body) {
    walkStatement(stmt, state);
  }
}

function walkExpr(expr: Expr, state: WalkState): void {
  switch (expr.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "undefined":
    case "ident":
      return;
    case "template":
      for (const part of expr.parts) {
        if (part.kind === "expr") walkExpr(part.expr, state);
      }
      return;
    case "array":
      for (const el of expr.elements) walkExpr(el, state);
      return;
    case "object":
      for (const p of expr.properties) walkExpr(p.value, state);
      return;
    case "unary":
      walkExpr(expr.argument, state);
      return;
    case "binary":
      walkExpr(expr.left, state);
      walkExpr(expr.right, state);
      return;
    case "assign":
      walkExpr(expr.target, state);
      walkExpr(expr.value, state);
      return;
    case "ternary":
      walkExpr(expr.test, state);
      walkExpr(expr.consequent, state);
      walkExpr(expr.alternate, state);
      return;
    case "member":
      walkExpr(expr.object, state);
      return;
    case "index":
      walkExpr(expr.object, state);
      walkExpr(expr.index, state);
      return;
    case "new":
      walkExpr(expr.callee, state);
      for (const a of expr.args) walkExpr(a, state);
      return;
    case "assert":
      walkExpr(expr.expression, state);
      return;
    case "arrow": {
      // A nested function runs later. Effect callbacks are walked separately.
      const nested = { ...state, inConditional: false, inEffect: false };
      if (expr.body.kind === "block") walkBlock(expr.body, nested);
      else walkExpr(expr.body, nested);
      return;
    }
    case "call":
      walkCall(expr, state);
      return;
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}

function walkCall(
  expr: Extract<Expr, { kind: "call" }>,
  state: WalkState,
): void {
  const calleeName =
    expr.callee.kind === "ident" ? expr.callee.name : null;

  let walkArg: ((arg: Expr, index: number) => void) | null = null;

  if (calleeName !== null) {
    if (
      state.locals.signal.has(calleeName) ||
      state.locals.computed.has(calleeName)
    ) {
      state.signals.push(expr.span);
      if (state.inConditional) {
        state.issues.push(
          domIssue(
            state,
            "jsv.dom.conditional_signal",
            `Call to '${calleeName}()' is nested inside a conditional.`,
            expr.span,
          ),
        );
      }
      if (state.inEffect) {
        state.issues.push(
          domIssue(
            state,
            "jsv.dom.signal_in_effect",
            `Call to '${calleeName}()' is inside an effect. Create it outside the effect.`,
            expr.span,
          ),
        );
      }
      if (state.locals.computed.has(calleeName)) {
        checkComputedWrites(expr, state);
      }
    } else if (state.locals.effect.has(calleeName)) {
      state.effects.push(expr.span);
      checkEffectSelfWrite(expr, state);
      checkEffectShouldBeComputed(expr, state);
      walkArg = (arg, index) => {
        if (index === 0) walkEffectCallback(arg, state);
        else walkExpr(arg, state);
      };
    } else if (state.locals.list.has(calleeName)) {
      state.lists.push(expr.span);
      checkListUnusedItem(expr, state);
      checkListKey(expr, state);
    }
  }

  walkExpr(expr.callee, state);
  expr.args.forEach((arg, index) => {
    if (walkArg !== null) walkArg(arg, index);
    else walkExpr(arg, state);
  });
}

function domIssue(
  state: WalkState,
  code: string,
  message: string,
  span: Span,
): Diagnostic {
  return {
    code,
    severity: "warning",
    message,
    file: state.file,
    start: span.start,
    end: span.end,
  };
}

function walkEffectCallback(expr: Expr, state: WalkState): void {
  const inner = { ...state, inEffect: true };
  if (expr.kind === "arrow") {
    if (expr.body.kind === "block") walkBlock(expr.body, inner);
    else walkExpr(expr.body, inner);
    return;
  }
  walkExpr(expr, inner);
}

function checkEffectSelfWrite(
  call: Extract<Expr, { kind: "call" }>,
  state: WalkState,
): void {
  const cb = call.args[0];
  if (cb === undefined || cb.kind !== "arrow") return;

  const reads = new Set<string>();
  const writes = new Set<string>();
  collectSignalAccesses(cb.body, reads, writes);

  for (const name of reads) {
    if (writes.has(name)) {
      state.issues.push(
        domIssue(
          state,
          "jsv.dom.effect_self_write",
          `Effect both reads and writes '${name}'.`,
          call.span,
        ),
      );
      return;
    }
  }
}

function checkEffectShouldBeComputed(
  call: Extract<Expr, { kind: "call" }>,
  state: WalkState,
): void {
  const derived = effectDerivation(call);
  if (derived === null) return;
  state.issues.push(
    domIssue(
      state,
      "jsv.dom.effect_should_be_computed",
      `Effect only derives '${derived.target}' from other signals. Use computed instead.`,
      call.span,
    ),
  );
}

function effectDerivation(
  call: Extract<Expr, { kind: "call" }>,
): { target: string; value: Expr } | null {
  const cb = call.args[0];
  if (cb === undefined || cb.kind !== "arrow") return null;
  const set = singleSetCall(cb.body);
  if (set === null) return null;
  const reads = new Set<string>();
  const writes = new Set<string>();
  collectSignalAccesses(cb.body, reads, writes);
  if (writes.size !== 1 || !writes.has(set.target)) return null;
  if (reads.has(set.target) || reads.size === 0) return null;
  if (!callsAreAllowed(cb.body, set.target)) return null;
  const valueReads = new Set<string>();
  collectSignalAccesses(set.value, valueReads, new Set());
  let usesRead = false;
  for (const name of valueReads) {
    if (reads.has(name)) usesRead = true;
  }
  if (!usesRead) return null;
  return set;
}

function singleSetCall(
  body: Expr | Block,
): { target: string; value: Expr } | null {
  let expr: Expr;
  if (body.kind === "block") {
    if (body.body.length !== 1) return null;
    const stmt = body.body[0];
    if (stmt === undefined || stmt.kind !== "expr_stmt") return null;
    expr = stmt.expression;
  } else {
    expr = body;
  }
  if (expr.kind !== "call" || expr.args.length !== 1) return null;
  const arg = expr.args[0];
  if (arg === undefined) return null;
  if (expr.callee.kind !== "member" || expr.callee.property !== "set") {
    return null;
  }
  if (expr.callee.object.kind !== "ident") return null;
  return { target: expr.callee.object.name, value: arg };
}

function checkComputedWrites(
  call: Extract<Expr, { kind: "call" }>,
  state: WalkState,
): void {
  const cb = call.args[0];
  if (cb === undefined || cb.kind !== "arrow") return;
  const writes = new Set<string>();
  collectSignalAccesses(cb.body, new Set(), writes);
  if (writes.size === 0) return;
  const names = [...writes]
    .sort()
    .map((name) => `'${name}'`)
    .join(", ");
  state.issues.push(
    domIssue(
      state,
      "jsv.dom.computed_writes",
      `Computed writes ${names}. Move the write into an effect.`,
      call.span,
    ),
  );
}

function collectSignalAccesses(
  node: Expr | Block | Statement,
  reads: Set<string>,
  writes: Set<string>,
): void {
  if (node.kind === "block") {
    for (const s of node.body) collectSignalAccesses(s, reads, writes);
    return;
  }
  if (
    node.kind === "import" ||
    node.kind === "empty" ||
    node.kind === "type_alias" ||
    node.kind === "interface"
  ) {
    return;
  }
  if (node.kind === "var") {
    if (node.init !== null) collectSignalAccesses(node.init, reads, writes);
    return;
  }
  if (node.kind === "function") {
    collectSignalAccesses(node.body, reads, writes);
    return;
  }
  if (node.kind === "class") {
    for (const m of node.members) {
      if (m.kind === "constructor" || m.kind === "method") {
        collectSignalAccesses(m.body, reads, writes);
      }
    }
    return;
  }
  if (node.kind === "if") {
    collectSignalAccesses(node.test, reads, writes);
    collectSignalAccesses(node.consequent, reads, writes);
    if (node.alternate !== null) {
      collectSignalAccesses(node.alternate, reads, writes);
    }
    return;
  }
  if (node.kind === "while") {
    collectSignalAccesses(node.test, reads, writes);
    collectSignalAccesses(node.body, reads, writes);
    return;
  }
  if (node.kind === "for") {
    if (node.init !== null) {
      if (node.init.kind === "var") {
        if (node.init.init !== null) {
          collectSignalAccesses(node.init.init, reads, writes);
        }
      } else {
        collectSignalAccesses(node.init, reads, writes);
      }
    }
    if (node.test !== null) collectSignalAccesses(node.test, reads, writes);
    if (node.update !== null) {
      collectSignalAccesses(node.update, reads, writes);
    }
    collectSignalAccesses(node.body, reads, writes);
    return;
  }
  if (node.kind === "return") {
    if (node.argument !== null) {
      collectSignalAccesses(node.argument, reads, writes);
    }
    return;
  }
  if (node.kind === "expr_stmt") {
    collectSignalAccesses(node.expression, reads, writes);
    return;
  }

  // Expr cases
  const expr = node as Expr;
  switch (expr.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "undefined":
    case "ident":
      return;
    case "template":
      for (const part of expr.parts) {
        if (part.kind === "expr") {
          collectSignalAccesses(part.expr, reads, writes);
        }
      }
      return;
    case "array":
      for (const el of expr.elements) collectSignalAccesses(el, reads, writes);
      return;
    case "object":
      for (const p of expr.properties) {
        collectSignalAccesses(p.value, reads, writes);
      }
      return;
    case "unary":
      collectSignalAccesses(expr.argument, reads, writes);
      return;
    case "binary":
      collectSignalAccesses(expr.left, reads, writes);
      collectSignalAccesses(expr.right, reads, writes);
      return;
    case "assign":
      collectSignalAccesses(expr.target, reads, writes);
      collectSignalAccesses(expr.value, reads, writes);
      return;
    case "ternary":
      collectSignalAccesses(expr.test, reads, writes);
      collectSignalAccesses(expr.consequent, reads, writes);
      collectSignalAccesses(expr.alternate, reads, writes);
      return;
    case "member":
      collectSignalAccesses(expr.object, reads, writes);
      return;
    case "index":
      collectSignalAccesses(expr.object, reads, writes);
      collectSignalAccesses(expr.index, reads, writes);
      return;
    case "new":
      collectSignalAccesses(expr.callee, reads, writes);
      for (const a of expr.args) collectSignalAccesses(a, reads, writes);
      return;
    case "assert":
      collectSignalAccesses(expr.expression, reads, writes);
      return;
    case "arrow":
      if (expr.body.kind === "block") {
        collectSignalAccesses(expr.body, reads, writes);
      } else {
        collectSignalAccesses(expr.body, reads, writes);
      }
      return;
    case "call": {
      // count.get() / count.set() / count.update()
      if (
        expr.callee.kind === "member" &&
        expr.callee.object.kind === "ident"
      ) {
        const name = expr.callee.object.name;
        const prop = expr.callee.property;
        if (prop === "get") reads.add(name);
        else if (prop === "set" || prop === "update") writes.add(name);
      }
      collectSignalAccesses(expr.callee, reads, writes);
      for (const a of expr.args) collectSignalAccesses(a, reads, writes);
      return;
    }
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}

function checkListKey(
  call: Extract<Expr, { kind: "call" }>,
  state: WalkState,
): void {
  if (call.args.length < 3) {
    state.issues.push(
      domIssue(
        state,
        "jsv.dom.list_missing_key",
        `list() expects (items, key, render) but was called with ${call.args.length} argument(s).`,
        call.span,
      ),
    );
    return;
  }
  const key = call.args[1];
  if (key === undefined) return;
  if (key.kind === "string") {
    state.issues.push(
      domIssue(
        state,
        "jsv.dom.list_constant_key",
        "List key is a constant string, so every row shares one key.",
        call.span,
      ),
    );
    return;
  }
  if (key.kind !== "arrow") return;
  const first = key.params[0];
  if (first !== undefined && identReferenced(key.body, first.name)) return;
  const message =
    first === undefined
      ? "List key does not use its item, so every row shares one key."
      : `List key parameter '${first.name}' is never referenced, so every row shares one key.`;
  state.issues.push(
    domIssue(state, "jsv.dom.list_constant_key", message, call.span),
  );
}

function callsAreAllowed(
  node: Expr | Block | Statement,
  target: string,
): boolean {
  if (node.kind === "block") {
    return node.body.every((stmt) => callsAreAllowed(stmt, target));
  }
  if (
    node.kind === "import" ||
    node.kind === "empty" ||
    node.kind === "type_alias" ||
    node.kind === "interface"
  ) {
    return true;
  }
  if (node.kind === "var") {
    return node.init === null || callsAreAllowed(node.init, target);
  }
  if (node.kind === "function") return callsAreAllowed(node.body, target);
  if (node.kind === "class") {
    return node.members.every(
      (member) =>
        (member.kind !== "constructor" && member.kind !== "method") ||
        callsAreAllowed(member.body, target),
    );
  }
  if (node.kind === "if") {
    return (
      callsAreAllowed(node.test, target) &&
      callsAreAllowed(node.consequent, target) &&
      (node.alternate === null || callsAreAllowed(node.alternate, target))
    );
  }
  if (node.kind === "while") {
    return (
      callsAreAllowed(node.test, target) && callsAreAllowed(node.body, target)
    );
  }
  if (node.kind === "for") {
    const initOk =
      node.init === null ||
      (node.init.kind === "var"
        ? node.init.init === null || callsAreAllowed(node.init.init, target)
        : callsAreAllowed(node.init, target));
    return (
      initOk &&
      (node.test === null || callsAreAllowed(node.test, target)) &&
      (node.update === null || callsAreAllowed(node.update, target)) &&
      callsAreAllowed(node.body, target)
    );
  }
  if (node.kind === "return") {
    return node.argument === null || callsAreAllowed(node.argument, target);
  }
  if (node.kind === "expr_stmt") return callsAreAllowed(node.expression, target);

  const expr = node as Expr;
  switch (expr.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "undefined":
    case "ident":
      return true;
    case "template":
      return expr.parts.every(
        (part) => part.kind !== "expr" || callsAreAllowed(part.expr, target),
      );
    case "array":
      return expr.elements.every((el) => callsAreAllowed(el, target));
    case "object":
      return expr.properties.every((prop) => callsAreAllowed(prop.value, target));
    case "unary":
      return callsAreAllowed(expr.argument, target);
    case "binary":
      return (
        callsAreAllowed(expr.left, target) && callsAreAllowed(expr.right, target)
      );
    case "assign":
      return (
        callsAreAllowed(expr.target, target) &&
        callsAreAllowed(expr.value, target)
      );
    case "ternary":
      return (
        callsAreAllowed(expr.test, target) &&
        callsAreAllowed(expr.consequent, target) &&
        callsAreAllowed(expr.alternate, target)
      );
    case "member":
      return callsAreAllowed(expr.object, target);
    case "index":
      return (
        callsAreAllowed(expr.object, target) &&
        callsAreAllowed(expr.index, target)
      );
    case "new":
      return (
        callsAreAllowed(expr.callee, target) &&
        expr.args.every((arg) => callsAreAllowed(arg, target))
      );
    case "assert":
      return callsAreAllowed(expr.expression, target);
    case "arrow":
      return callsAreAllowed(expr.body, target);
    case "call": {
      const get =
        expr.callee.kind === "member" &&
        expr.callee.property === "get" &&
        expr.args.length === 0;
      const set =
        expr.callee.kind === "member" &&
        expr.callee.object.kind === "ident" &&
        expr.callee.object.name === target &&
        expr.callee.property === "set";
      if (!get && !set) return false;
      return (
        callsAreAllowed(expr.callee, target) &&
        expr.args.every((arg) => callsAreAllowed(arg, target))
      );
    }
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}

function checkListUnusedItem(
  call: Extract<Expr, { kind: "call" }>,
  state: WalkState,
): void {
  const render = call.args[2];
  if (render === undefined) return;
  if (render.kind !== "arrow") return;
  const first = render.params[0];
  if (first === undefined) return;
  const paramName = first.name;
  if (identReferenced(render.body, paramName)) return;
  state.issues.push({
    code: "jsv.dom.list_unused_item",
    severity: "warning",
    message: `List render parameter '${paramName}' is never referenced.`,
    file: state.file,
    start: call.span.start,
    end: call.span.end,
  });
}

function identReferenced(node: Expr | Block | Statement, name: string): boolean {
  if (node.kind === "block") {
    return node.body.some((s) => identReferenced(s, name));
  }
  if (
    node.kind === "import" ||
    node.kind === "empty" ||
    node.kind === "type_alias" ||
    node.kind === "interface"
  ) {
    return false;
  }
  if (node.kind === "var") {
    return node.init !== null && identReferenced(node.init, name);
  }
  if (node.kind === "function") {
    return identReferenced(node.body, name);
  }
  if (node.kind === "class") {
    return node.members.some(
      (m) =>
        (m.kind === "constructor" || m.kind === "method") &&
        identReferenced(m.body, name),
    );
  }
  if (node.kind === "if") {
    return (
      identReferenced(node.test, name) ||
      identReferenced(node.consequent, name) ||
      (node.alternate !== null && identReferenced(node.alternate, name))
    );
  }
  if (node.kind === "while") {
    return identReferenced(node.test, name) || identReferenced(node.body, name);
  }
  if (node.kind === "for") {
    const initHit =
      node.init !== null &&
      (node.init.kind === "var"
        ? node.init.init !== null && identReferenced(node.init.init, name)
        : identReferenced(node.init, name));
    return (
      initHit ||
      (node.test !== null && identReferenced(node.test, name)) ||
      (node.update !== null && identReferenced(node.update, name)) ||
      identReferenced(node.body, name)
    );
  }
  if (node.kind === "return") {
    return node.argument !== null && identReferenced(node.argument, name);
  }
  if (node.kind === "expr_stmt") {
    return identReferenced(node.expression, name);
  }

  const expr = node as Expr;
  switch (expr.kind) {
    case "number":
    case "string":
    case "boolean":
    case "null":
    case "undefined":
      return false;
    case "ident":
      return expr.name === name;
    case "template":
      return expr.parts.some(
        (p) => p.kind === "expr" && identReferenced(p.expr, name),
      );
    case "array":
      return expr.elements.some((el) => identReferenced(el, name));
    case "object":
      return expr.properties.some((p) => identReferenced(p.value, name));
    case "unary":
      return identReferenced(expr.argument, name);
    case "binary":
      return (
        identReferenced(expr.left, name) || identReferenced(expr.right, name)
      );
    case "assign":
      return (
        identReferenced(expr.target, name) || identReferenced(expr.value, name)
      );
    case "ternary":
      return (
        identReferenced(expr.test, name) ||
        identReferenced(expr.consequent, name) ||
        identReferenced(expr.alternate, name)
      );
    case "member":
      return identReferenced(expr.object, name);
    case "index":
      return (
        identReferenced(expr.object, name) || identReferenced(expr.index, name)
      );
    case "new":
      return (
        identReferenced(expr.callee, name) ||
        expr.args.some((a) => identReferenced(a, name))
      );
    case "assert":
      return identReferenced(expr.expression, name);
    case "arrow":
      return identReferenced(expr.body, name);
    case "call":
      return (
        identReferenced(expr.callee, name) ||
        expr.args.some((a) => identReferenced(a, name))
      );
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}
