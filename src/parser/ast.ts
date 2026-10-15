import type { SourcePosition } from "../diagnostics.ts";

export type Span = { start: SourcePosition; end: SourcePosition };

export type Program = {
  kind: "program";
  body: Statement[];
  span: Span;
};

export type Statement =
  | ImportStmt
  | VarStmt
  | FunctionDecl
  | TypeAlias
  | InterfaceDecl
  | ClassDecl
  | IfStmt
  | WhileStmt
  | ForStmt
  | ReturnStmt
  | Block
  | EmptyStmt
  | ExprStmt;

export type ImportStmt = {
  kind: "import";
  defaultName: string | null;
  defaultSpan: Span | null;
  names: { imported: string; local: string; span: Span }[];
  moduleSpecifier: string;
  span: Span;
};

export type VarStmt = {
  kind: "var";
  declKind: "let" | "const";
  exported: boolean;
  defaultExport: boolean;
  name: string;
  nameSpan: Span;
  type: TypeNode | null;
  init: Expr | null;
  span: Span;
};

export type Param = {
  name: string;
  nameSpan: Span;
  type: TypeNode;
  span: Span;
};

export type FunctionDecl = {
  kind: "function";
  exported: boolean;
  defaultExport: boolean;
  name: string;
  nameSpan: Span;
  typeParams: { name: string; span: Span }[];
  params: Param[];
  returnType: TypeNode;
  body: Block;
  span: Span;
};

export type TypeAlias = {
  kind: "type_alias";
  exported: boolean;
  name: string;
  nameSpan: Span;
  typeParams: { name: string; span: Span }[];
  type: TypeNode;
  span: Span;
};

export type TypeMember =
  | {
      kind: "prop";
      name: string;
      nameSpan: Span;
      optional: boolean;
      type: TypeNode;
      span: Span;
    }
  | {
      kind: "method_sig";
      name: string;
      nameSpan: Span;
      typeParams: { name: string; span: Span }[];
      params: Param[];
      returnType: TypeNode;
      span: Span;
    };

export type InterfaceDecl = {
  kind: "interface";
  exported: boolean;
  name: string;
  nameSpan: Span;
  typeParams: { name: string; span: Span }[];
  members: TypeMember[];
  span: Span;
};

export type ClassMember =
  | {
      kind: "field";
      name: string;
      nameSpan: Span;
      type: TypeNode;
      span: Span;
    }
  | {
      kind: "constructor";
      params: Param[];
      body: Block;
      span: Span;
    }
  | {
      kind: "method";
      name: string;
      nameSpan: Span;
      typeParams: { name: string; span: Span }[];
      params: Param[];
      returnType: TypeNode;
      body: Block;
      span: Span;
    };

export type ClassDecl = {
  kind: "class";
  exported: boolean;
  defaultExport: boolean;
  name: string;
  nameSpan: Span;
  members: ClassMember[];
  span: Span;
};

export type IfStmt = {
  kind: "if";
  test: Expr;
  consequent: Statement;
  alternate: Statement | null;
  span: Span;
};

export type WhileStmt = {
  kind: "while";
  test: Expr;
  body: Statement;
  span: Span;
};

export type ForStmt = {
  kind: "for";
  init: VarStmt | Expr | null;
  test: Expr | null;
  update: Expr | null;
  body: Statement;
  span: Span;
};

export type ReturnStmt = {
  kind: "return";
  argument: Expr | null;
  span: Span;
};

export type Block = {
  kind: "block";
  body: Statement[];
  span: Span;
};

export type EmptyStmt = {
  kind: "empty";
  span: Span;
};

export type ExprStmt = {
  kind: "expr_stmt";
  expression: Expr;
  span: Span;
};

export type TypeNode =
  | { kind: "prim"; name: PrimName; span: Span }
  | {
      kind: "named";
      name: string;
      nameSpan: Span;
      args: TypeNode[];
      span: Span;
    }
  | { kind: "array"; element: TypeNode; span: Span }
  | { kind: "object"; members: TypeMember[]; span: Span }
  | {
      kind: "function";
      params: Param[];
      returnType: TypeNode;
      span: Span;
    }
  | { kind: "union"; types: TypeNode[]; span: Span };

export type PrimName =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "void"
  | "never"
  | "unknown"
  | "undefined";

export type Expr =
  | {
      kind: "number";
      value: number;
      raw: string;
      span: Span;
    }
  | { kind: "string"; value: string; span: Span }
  | { kind: "boolean"; value: boolean; span: Span }
  | { kind: "null"; span: Span }
  | { kind: "undefined"; span: Span }
  | { kind: "ident"; name: string; span: Span }
  | {
      kind: "template";
      parts: Array<
        | { kind: "text"; value: string }
        | { kind: "expr"; expr: Expr }
      >;
      span: Span;
    }
  | { kind: "array"; elements: Expr[]; span: Span }
  | {
      kind: "object";
      properties: {
        name: string;
        nameSpan: Span;
        shorthand: boolean;
        value: Expr;
        span: Span;
      }[];
      span: Span;
    }
  | {
      kind: "unary";
      op: "!" | "-";
      argument: Expr;
      span: Span;
    }
  | {
      kind: "binary";
      op: BinaryOp;
      left: Expr;
      right: Expr;
      span: Span;
    }
  | {
      kind: "assign";
      target: Expr;
      value: Expr;
      span: Span;
    }
  | {
      kind: "ternary";
      test: Expr;
      consequent: Expr;
      alternate: Expr;
      span: Span;
    }
  | {
      kind: "call";
      callee: Expr;
      typeArgs: TypeNode[];
      args: Expr[];
      span: Span;
    }
  | {
      kind: "member";
      object: Expr;
      property: string;
      propertySpan: Span;
      span: Span;
    }
  | {
      kind: "index";
      object: Expr;
      index: Expr;
      span: Span;
    }
  | {
      kind: "new";
      callee: Expr;
      typeArgs: TypeNode[];
      args: Expr[];
      span: Span;
    }
  | {
      kind: "arrow";
      params: Param[];
      body: Expr | Block;
      span: Span;
    }
  | {
      kind: "assert";
      expression: Expr;
      type: TypeNode;
      span: Span;
    };

export type BinaryOp =
  | "||"
  | "&&"
  | "=="
  | "!="
  | "==="
  | "!=="
  | "<"
  | ">"
  | "<="
  | ">="
  | "+"
  | "-"
  | "*"
  | "/"
  | "%";
