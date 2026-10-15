import type { Diagnostic } from "../diagnostics.ts";
import {
  arrayType,
  functionType,
  objectType,
  prim,
  refType,
  unionType,
  type Type,
  type TypeDef,
} from "./types.ts";

export type DomLibBinding = {
  name: string;
  kind: "value" | "type" | "both";
  mutable: boolean;
  valueType: Type;
  typeDef?: TypeDef;
};

export type DomLibModule = {
  namedValues: Map<string, DomLibBinding>;
  namedTypes: Map<string, DomLibBinding>;
  defaultExport: DomLibBinding | null;
  diagnostics: Diagnostic[];
  parseFailed: boolean;
};

function typeBinding(name: string, typeDef: TypeDef): DomLibBinding {
  return {
    name,
    kind: "type",
    mutable: false,
    valueType: { kind: "error" },
    typeDef,
  };
}

function valueBinding(name: string, valueType: Type): DomLibBinding {
  return {
    name,
    kind: "value",
    mutable: false,
    valueType,
  };
}

/** Ambient module for specifier `jsv/dom` (no filesystem read). */
export function createDomLibModule(): DomLibModule {
  const nodeDef: TypeDef = {
    name: "Node",
    typeParams: [],
    body: objectType([
      { name: "nodeKind", optional: false, type: prim("string") },
    ]),
  };

  const signalDef: TypeDef = {
    name: "Signal",
    typeParams: ["T"],
    body: objectType([
      {
        name: "get",
        optional: false,
        type: functionType([], { kind: "type_param", name: "T" }),
      },
      {
        name: "set",
        optional: false,
        type: functionType(
          [{ name: "value", type: { kind: "type_param", name: "T" } }],
          prim("void"),
        ),
      },
      {
        name: "update",
        optional: false,
        type: functionType(
          [
            {
              name: "fn",
              type: functionType(
                [{ name: "value", type: { kind: "type_param", name: "T" } }],
                { kind: "type_param", name: "T" },
              ),
            },
          ],
          prim("void"),
        ),
      },
    ]),
  };

  const computedDef: TypeDef = {
    name: "Computed",
    typeParams: ["T"],
    body: objectType([
      {
        name: "get",
        optional: false,
        type: functionType([], { kind: "type_param", name: "T" }),
      },
    ]),
  };

  const tParam: Type = { kind: "type_param", name: "T" };
  const signalOf = (t: Type) => refType(signalDef, [t]);
  const computedOf = (t: Type) => refType(computedDef, [t]);
  const nodeType = refType(nodeDef);

  const stringish = unionType([
    prim("string"),
    signalOf(prim("string")),
    computedOf(prim("string")),
  ]);

  const domPropsDef: TypeDef = {
    name: "DomProps",
    typeParams: [],
    body: objectType([
      { name: "id", optional: true, type: stringish },
      { name: "className", optional: true, type: stringish },
      { name: "value", optional: true, type: stringish },
      {
        name: "onClick",
        optional: true,
        type: functionType([], prim("void")),
      },
      {
        name: "onInput",
        optional: true,
        type: functionType(
          [{ name: "value", type: prim("string") }],
          prim("void"),
        ),
      },
    ]),
  };

  const namedTypes = new Map<string, DomLibBinding>();
  namedTypes.set("Node", typeBinding("Node", nodeDef));
  namedTypes.set("Signal", typeBinding("Signal", signalDef));
  namedTypes.set("Computed", typeBinding("Computed", computedDef));
  namedTypes.set("DomProps", typeBinding("DomProps", domPropsDef));

  const namedValues = new Map<string, DomLibBinding>();
  namedValues.set(
    "signal",
    valueBinding(
      "signal",
      functionType(
        [{ name: "initial", type: tParam }],
        signalOf(tParam),
        ["T"],
      ),
    ),
  );
  namedValues.set(
    "computed",
    valueBinding(
      "computed",
      functionType(
        [{ name: "fn", type: functionType([], tParam) }],
        computedOf(tParam),
        ["T"],
      ),
    ),
  );
  namedValues.set(
    "effect",
    valueBinding(
      "effect",
      functionType(
        [{ name: "fn", type: functionType([], prim("void")) }],
        functionType([], prim("void")),
      ),
    ),
  );
  namedValues.set(
    "text",
    valueBinding(
      "text",
      functionType([{ name: "value", type: stringish }], nodeType),
    ),
  );
  namedValues.set(
    "h",
    valueBinding(
      "h",
      functionType(
        [
          { name: "tag", type: prim("string") },
          { name: "props", type: refType(domPropsDef) },
          { name: "children", type: arrayType(nodeType) },
        ],
        nodeType,
      ),
    ),
  );
  namedValues.set(
    "fragment",
    valueBinding(
      "fragment",
      functionType(
        [{ name: "children", type: arrayType(nodeType) }],
        nodeType,
      ),
    ),
  );
  namedValues.set(
    "list",
    valueBinding(
      "list",
      functionType(
        [
          {
            name: "items",
            type: unionType([
              signalOf(arrayType(tParam)),
              computedOf(arrayType(tParam)),
            ]),
          },
          {
            name: "key",
            type: functionType(
              [{ name: "item", type: tParam }],
              prim("string"),
            ),
          },
          {
            name: "render",
            type: functionType(
              [{ name: "item", type: signalOf(tParam) }],
              nodeType,
            ),
          },
        ],
        nodeType,
        ["T"],
      ),
    ),
  );

  return {
    namedValues,
    namedTypes,
    defaultExport: null,
    diagnostics: [],
    parseFailed: false,
  };
}
