import type { PrimName } from "../parser/ast.ts";

export type PropType = {
  name: string;
  optional: boolean;
  type: Type;
};

export type FnParamType = {
  name: string;
  type: Type;
  /** Callers may omit this argument. The binding type includes `undefined`. */
  optional?: boolean;
};

/**
 * Ambient `Promise<T>`. Identity is the def object, so user aliases named
 * `Promise` do not get Promise assignability or `await` unwrapping.
 * The body is never expanded: `await` and assignability read `args` directly.
 */
export const PROMISE_DEF: TypeDef = {
  name: "Promise",
  typeParams: ["T"],
  body: { kind: "object", props: [] },
};

export function promiseType(inner: Type): Type {
  return refType(PROMISE_DEF, [inner]);
}

export function isPromise(type: Type): boolean {
  return type.kind === "ref" && type.def === PROMISE_DEF;
}

/** Shared mutable definition for aliases, interfaces, and class instance types. */
export type TypeDef = {
  name: string;
  typeParams: string[];
  body: Type;
};

export type Type =
  | { kind: "prim"; name: PrimName }
  | { kind: "array"; element: Type }
  | { kind: "union"; members: Type[] }
  | { kind: "object"; props: PropType[] }
  | {
      kind: "function";
      typeParams: string[];
      params: FnParamType[];
      returnType: Type;
      anyArity?: boolean;
    }
  | { kind: "type_param"; name: string }
  | { kind: "ref"; def: TypeDef; args: Type[] }
  | { kind: "error" };

export const ERROR_TYPE: Type = { kind: "error" };

export function prim(name: PrimName): Type {
  return { kind: "prim", name };
}

export function arrayType(element: Type): Type {
  return { kind: "array", element };
}

export function unionType(members: Type[]): Type {
  const flat: Type[] = [];
  for (const m of members) {
    if (m.kind === "union") {
      for (const inner of m.members) flat.push(inner);
    } else if (m.kind !== "error") {
      flat.push(m);
    }
  }
  if (flat.length === 0) return ERROR_TYPE;
  if (flat.length === 1) return flat[0] ?? ERROR_TYPE;
  return { kind: "union", members: flat };
}

export function objectType(props: PropType[]): Type {
  return { kind: "object", props };
}

export function functionType(
  params: FnParamType[],
  returnType: Type,
  typeParams: string[] = [],
  anyArity = false,
): Type {
  const fn: Type = {
    kind: "function",
    typeParams,
    params,
    returnType,
  };
  if (anyArity) {
    return { ...fn, anyArity: true };
  }
  return fn;
}

export function refType(def: TypeDef, args: Type[] = []): Type {
  return { kind: "ref", def, args };
}

export function typeToString(type: Type, seen?: Set<TypeDef>): string {
  const visiting = seen ?? new Set<TypeDef>();
  switch (type.kind) {
    case "prim":
      return type.name;
    case "array": {
      const elem = typeToString(type.element, visiting);
      if (type.element.kind === "union" || type.element.kind === "function") {
        return `(${elem})[]`;
      }
      return `${elem}[]`;
    }
    case "union":
      return type.members.map((m) => typeToString(m, visiting)).join(" | ");
    case "object": {
      const parts = type.props.map((p) => {
        if (p.type.kind === "function" && p.type.typeParams.length === 0) {
          const params = p.type.params
            .map((param) => formatParam(param, visiting))
            .join(", ");
          return `${p.name}${p.optional ? "?" : ""}: (${params}) => ${typeToString(p.type.returnType, visiting)}`;
        }
        return `${p.name}${p.optional ? "?" : ""}: ${typeToString(p.type, visiting)}`;
      });
      return `{ ${parts.join(", ")} }`;
    }
    case "function": {
      const tparams =
        type.typeParams.length > 0 ? `<${type.typeParams.join(", ")}>` : "";
      const params = type.params
        .map((p) => formatParam(p, visiting))
        .join(", ");
      return `${tparams}(${params}) => ${typeToString(type.returnType, visiting)}`;
    }
    case "type_param":
      return type.name;
    case "ref": {
      if (type.args.length > 0) {
        return `${type.def.name}<${type.args.map((a) => typeToString(a, visiting)).join(", ")}>`;
      }
      return type.def.name;
    }
    case "error":
      return "?";
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

function formatParam(p: FnParamType, visiting: Set<TypeDef>): string {
  return `${p.name}${p.optional ? "?" : ""}: ${typeToString(p.type, visiting)}`;
}

export function expand(type: Type): Type {
  if (type.kind !== "ref") return type;
  const subst = new Map<string, Type>();
  for (let i = 0; i < type.def.typeParams.length; i++) {
    const tp = type.def.typeParams[i];
    const arg = type.args[i];
    if (tp !== undefined && arg !== undefined) subst.set(tp, arg);
  }
  return substitute(type.def.body, subst);
}

export function substitute(type: Type, subst: Map<string, Type>): Type {
  switch (type.kind) {
    case "prim":
    case "error":
      return type;
    case "type_param":
      return subst.get(type.name) ?? type;
    case "array":
      return arrayType(substitute(type.element, subst));
    case "union":
      return unionType(type.members.map((m) => substitute(m, subst)));
    case "object":
      return objectType(
        type.props.map((p) => ({
          ...p,
          type: substitute(p.type, subst),
        })),
      );
    case "function": {
      const inner = new Map(subst);
      for (const tp of type.typeParams) inner.delete(tp);
      return functionType(
        type.params.map((p) => {
          const next: FnParamType = {
            name: p.name,
            type: substitute(p.type, inner),
          };
          if (p.optional === true) next.optional = true;
          return next;
        }),
        substitute(type.returnType, inner),
        type.typeParams,
        type.anyArity === true,
      );
    }
    case "ref":
      return {
        kind: "ref",
        def: type.def,
        args: type.args.map((a) => substitute(a, subst)),
      };
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}

/** Fully unwrap refs that immediately alias another type (for prim checks). */
export function unwrap(type: Type, seen?: Set<TypeDef>): Type {
  const visiting = seen ?? new Set<TypeDef>();
  let t = type;
  while (t.kind === "ref") {
    if (t.def === PROMISE_DEF) return t;
    if (visiting.has(t.def)) return t;
    visiting.add(t.def);
    t = expand(t);
  }
  return t;
}

/** Resolved type of `await` on `type`. Non-promises pass through. Nested `Promise`s unwrap. */
export function awaitType(type: Type, depth = 0): Type {
  if (type.kind === "error" || depth > 20) return type;
  const t = unwrap(type);
  if (t.kind === "ref" && t.def === PROMISE_DEF) {
    return awaitType(t.args[0] ?? ERROR_TYPE, depth + 1);
  }
  if (t.kind === "union") {
    return unionType(t.members.map((m) => awaitType(m, depth + 1)));
  }
  return type;
}

/** `T` when `type` is `Promise<T>` (aliases unwrapped). Otherwise null. */
export function promiseInner(type: Type): Type | null {
  const t = unwrap(type);
  if (t.kind !== "ref" || t.def !== PROMISE_DEF) return null;
  return t.args[0] ?? null;
}

export function isNever(type: Type): boolean {
  const t = unwrap(type);
  if (t.kind === "prim" && t.name === "never") return true;
  if (t.kind === "union") return t.members.every(isNever);
  return false;
}

export function isUnknown(type: Type): boolean {
  const t = unwrap(type);
  return t.kind === "prim" && t.name === "unknown";
}

export function isVoid(type: Type): boolean {
  const t = unwrap(type);
  return t.kind === "prim" && t.name === "void";
}

export function optionalReadType(type: Type): Type {
  const t = unwrap(type);
  if (t.kind === "union") {
    if (t.members.some((m) => {
      const u = unwrap(m);
      return u.kind === "prim" && u.name === "undefined";
    })) {
      return type;
    }
    return unionType([...t.members, prim("undefined")]);
  }
  if (t.kind === "prim" && t.name === "undefined") return type;
  return unionType([type, prim("undefined")]);
}

export function excludeType(from: Type, excluded: Type): Type {
  const f = unwrap(from);
  const eu = unwrap(excluded);
  if (f.kind === "union") {
    const kept = f.members.filter((m) => {
      const mu = unwrap(m);
      if (mu.kind === "prim" && eu.kind === "prim") return mu.name !== eu.name;
      return true;
    });
    if (kept.length === 0) return prim("never");
    return unionType(kept);
  }
  if (f.kind === "prim" && eu.kind === "prim" && f.name === eu.name) {
    return prim("never");
  }
  return from;
}

export function intersectNarrow(from: Type, target: Type): Type {
  const f = unwrap(from);
  if (isAssignable(from, target)) return from;
  if (isAssignable(target, from)) return target;
  if (f.kind === "union") {
    const kept = f.members.filter((m) => typesOverlap(m, target));
    if (kept.length === 0) return target;
    const assignable = kept.filter((m) => isAssignable(m, target));
    if (assignable.length > 0) return unionType(assignable);
    return unionType(kept);
  }
  if (typesOverlap(from, target)) return target;
  return prim("never");
}

type VisitSet = Set<string>;

function pairKey(a: Type, b: Type): string {
  return `${typeToString(a)}<:${typeToString(b)}`;
}

export function isAssignable(
  source: Type,
  target: Type,
  visited?: VisitSet,
): boolean {
  if (source.kind === "error" || target.kind === "error") return true;

  const seen = visited ?? new Set<string>();
  const key = pairKey(source, target);
  if (seen.has(key)) return true;
  seen.add(key);

  if (isNever(source)) return true;
  if (isNever(target)) return isNever(source);
  if (isUnknown(target)) return true;
  if (isUnknown(source)) return isUnknown(target);

  // Expand aliases. Promise stays nominal so Promise<T> is not `{}`.
  if (source.kind === "ref" || target.kind === "ref") {
    const s =
      source.kind === "ref" && source.def !== PROMISE_DEF
        ? expand(source)
        : source;
    const t =
      target.kind === "ref" && target.def !== PROMISE_DEF
        ? expand(target)
        : target;
    if (
      (s.kind === "ref" && s.def === PROMISE_DEF) ||
      (t.kind === "ref" && t.def === PROMISE_DEF)
    ) {
      if (
        s.kind === "ref" &&
        t.kind === "ref" &&
        s.def === PROMISE_DEF &&
        t.def === PROMISE_DEF
      ) {
        return isAssignable(s.args[0] ?? ERROR_TYPE, t.args[0] ?? ERROR_TYPE, seen);
      }
      return false;
    }
    return isAssignable(s, t, seen);
  }

  // Source unions first so U is assignable to U (and to any target that
  // accepts every member). Target unions succeed when some member accepts.
  if (source.kind === "union") {
    return source.members.every((m) => isAssignable(m, target, seen));
  }
  if (target.kind === "union") {
    return target.members.some((m) => isAssignable(source, m, seen));
  }

  if (source.kind === "prim" && target.kind === "prim") {
    return source.name === target.name;
  }

  if (source.kind === "type_param" && target.kind === "type_param") {
    return source.name === target.name;
  }
  if (source.kind === "type_param" || target.kind === "type_param") {
    return false;
  }

  if (source.kind === "array" && target.kind === "array") {
    return isAssignable(source.element, target.element, seen);
  }

  if (source.kind === "function" && target.kind === "function") {
    if (source.anyArity === true || target.anyArity === true) {
      return isAssignable(source.returnType, target.returnType, seen);
    }
    if (source.params.length !== target.params.length) return false;
    if (source.typeParams.length !== target.typeParams.length) return false;
    for (let i = 0; i < target.params.length; i++) {
      const tp = target.params[i];
      const sp = source.params[i];
      if (tp === undefined || sp === undefined) return false;
      // A target optional parameter may be omitted, so the source must accept that.
      if (tp.optional === true && sp.optional !== true) return false;
      const tpType = tp.optional === true ? optionalReadType(tp.type) : tp.type;
      const spType = sp.optional === true ? optionalReadType(sp.type) : sp.type;
      if (!isAssignable(tpType, spType, seen)) return false;
    }
    return isAssignable(source.returnType, target.returnType, seen);
  }

  if (source.kind === "object" && target.kind === "object") {
    for (const tp of target.props) {
      const sp = source.props.find((p) => p.name === tp.name);
      if (sp === undefined) {
        if (!tp.optional) return false;
        continue;
      }
      if (!tp.optional && sp.optional) return false;
      if (!isAssignable(sp.type, tp.type, seen)) return false;
    }
    return true;
  }

  return false;
}

export function typesOverlap(a: Type, b: Type, visited?: VisitSet): boolean {
  if (a.kind === "error" || b.kind === "error") return true;
  if (isUnknown(a) || isUnknown(b)) return true;
  if (isNever(a) || isNever(b)) return true;

  const seen = visited ?? new Set<string>();
  const key = `${typeToString(a)}~${typeToString(b)}`;
  if (seen.has(key)) return true;
  seen.add(key);

  if (a.kind === "ref" && a.def === PROMISE_DEF) {
    if (b.kind === "ref" && b.def === PROMISE_DEF) {
      return typesOverlap(a.args[0] ?? ERROR_TYPE, b.args[0] ?? ERROR_TYPE, seen);
    }
    if (b.kind === "ref") return typesOverlap(a, expand(b), seen);
    return false;
  }
  if (b.kind === "ref" && b.def === PROMISE_DEF) {
    if (a.kind === "ref") return typesOverlap(expand(a), b, seen);
    return false;
  }
  if (a.kind === "ref") return typesOverlap(expand(a), b, seen);
  if (b.kind === "ref") return typesOverlap(a, expand(b), seen);

  if (a.kind === "union") {
    return a.members.some((m) => typesOverlap(m, b, seen));
  }
  if (b.kind === "union") {
    return b.members.some((m) => typesOverlap(a, m, seen));
  }

  if (a.kind === "array" && b.kind === "array") {
    return typesOverlap(a.element, b.element, seen);
  }

  return isAssignable(a, b, seen) || isAssignable(b, a, seen);
}

export function propertyNames(type: Type): string[] {
  const t = unwrap(type);
  if (t.kind === "object") return t.props.map((p) => p.name);
  return [];
}

export function getProperty(
  type: Type,
  name: string,
): { type: Type; optional: boolean } | null {
  const t = unwrap(type);
  if (t.kind !== "object") return null;
  const prop = t.props.find((p) => p.name === name);
  if (prop === undefined) return null;
  return { type: prop.type, optional: prop.optional };
}

/**
 * True when `type` (an alias body) refers back only through naked
 * alias/union chains — i.e. non-productive recursion.
 */
export function isNonProductiveAliasBody(
  type: Type,
  origin: TypeDef,
  stack: Set<TypeDef> = new Set(),
): boolean {
  if (type.kind === "prim" || type.kind === "error") return false;
  if (
    type.kind === "array" ||
    type.kind === "object" ||
    type.kind === "function"
  ) {
    return false;
  }
  if (type.kind === "type_param") return false;
  if (type.kind === "union") {
    return type.members.some((m) =>
      isNonProductiveAliasBody(m, origin, stack),
    );
  }
  if (type.kind === "ref") {
    if (stack.has(type.def)) return true;
    stack.add(type.def);
    const result = isNonProductiveAliasBody(type.def.body, origin, stack);
    stack.delete(type.def);
    return result;
  }
  return false;
}
