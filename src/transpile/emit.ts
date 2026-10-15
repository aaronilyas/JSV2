import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  Block,
  ClassDecl,
  Expr,
  FunctionDecl,
  ImportStmt,
  Program,
  Statement,
  VarStmt,
} from "../parser/ast.ts";

/** Value exports from the ambient `jsv/dom` module. */
export const JSV_DOM_VALUE_NAMES = new Set([
  "signal",
  "computed",
  "effect",
  "text",
  "h",
  "fragment",
  "list",
  "renderToString",
]);

export type ImportResolution = {
  /** Specifier written into the emitted import. */
  specifier: string;
  isValue: (importedName: string) => boolean;
  hasDefault: boolean;
};

export type EmitOptions = {
  resolveImport: (moduleSpecifier: string) => ImportResolution;
};

type EmitCtx = {
  options: EmitOptions;
  /** Vars under bare if/while that belong to the current statement list. */
  hoistedVars: Set<VarStmt>;
};

/** Absolute file URL of the runtime entry (`.ts` under src, `.js` under dist). */
export function jsvDomRuntimeSpecifier(): string {
  const tsUrl = new URL("../runtime/index.ts", import.meta.url);
  if (existsSync(fileURLToPath(tsUrl))) {
    return tsUrl.href;
  }
  return new URL("../runtime/index.js", import.meta.url).href;
}

export function collectValueExports(program: Program): {
  named: Set<string>;
  hasDefault: boolean;
} {
  const named = new Set<string>();
  let hasDefault = false;
  for (const stmt of program.body) {
    if (
      stmt.kind === "var" ||
      stmt.kind === "function" ||
      stmt.kind === "class"
    ) {
      if (!stmt.exported) continue;
      if (stmt.defaultExport) hasDefault = true;
      else named.add(stmt.name);
    }
  }
  return { named, hasDefault };
}

const PREC_PRIMARY = 100;
const PREC_POSTFIX = 90;
const PREC_UNARY = 80;
const PREC_MUL = 70;
const PREC_ADD = 60;
const PREC_CMP = 50;
const PREC_EQ = 40;
const PREC_AND = 30;
const PREC_OR = 20;
const PREC_NULLISH = 15;
const PREC_TERNARY = 10;
const PREC_ASSIGN = 5;

function binaryPrec(op: string): number {
  switch (op) {
    case "??":
      return PREC_NULLISH;
    case "||":
      return PREC_OR;
    case "&&":
      return PREC_AND;
    case "==":
    case "!=":
    case "===":
    case "!==":
      return PREC_EQ;
    case "<":
    case ">":
    case "<=":
    case ">=":
      return PREC_CMP;
    case "+":
    case "-":
      return PREC_ADD;
    case "*":
    case "/":
    case "%":
      return PREC_MUL;
    default:
      return PREC_PRIMARY;
  }
}

function exprPrec(expr: Expr): number {
  switch (expr.kind) {
    case "assign":
    case "arrow":
      return PREC_ASSIGN;
    case "ternary":
      return PREC_TERNARY;
    case "binary":
      return binaryPrec(expr.op);
    case "unary":
    case "await":
      return PREC_UNARY;
    case "assert":
      return exprPrec(expr.expression);
    case "call":
    case "member":
    case "index":
    case "new":
      return PREC_POSTFIX;
    default:
      return PREC_PRIMARY;
  }
}

function emitParams(params: { name: string }[]): string {
  return params.map((p) => p.name).join(", ");
}

/** Collect vars under bare if/while in this list; do not enter block/function/class/for. */
function collectHoistedVars(stmts: readonly Statement[]): VarStmt[] {
  const found: VarStmt[] = [];

  function walk(stmt: Statement): void {
    switch (stmt.kind) {
      case "if":
        walk(stmt.consequent);
        if (stmt.alternate !== null) walk(stmt.alternate);
        break;
      case "while":
        walk(stmt.body);
        break;
      case "var":
        found.push(stmt);
        break;
      default:
        break;
    }
  }

  for (const stmt of stmts) {
    if (stmt.kind === "if" || stmt.kind === "while") walk(stmt);
  }
  return found;
}

function emitStatementList(
  stmts: readonly Statement[],
  options: EmitOptions,
): string[] {
  const hoisted = collectHoistedVars(stmts);
  const hoistedVars = new Set<VarStmt>(hoisted);
  const lines: string[] = [];
  const declared = new Set<string>();
  for (const v of hoisted) {
    if (declared.has(v.name)) continue;
    declared.add(v.name);
    lines.push(`let ${v.name};`);
  }
  const ctx: EmitCtx = { options, hoistedVars };
  for (const stmt of stmts) {
    const emitted = emitStatement(stmt, ctx);
    if (emitted.length > 0) lines.push(emitted);
  }
  return lines;
}

function emitBlock(block: Block, options: EmitOptions): string {
  const lines = emitStatementList(block.body, options);
  if (lines.length === 0) return "{}";
  return `{\n${lines.join("\n")}\n}`;
}

function mixesNullish(op: string, child: Expr): boolean {
  if (child.kind !== "binary") return false;
  const childNullish = child.op === "??";
  const parentNullish = op === "??";
  const childLogical = child.op === "||" || child.op === "&&";
  const parentLogical = op === "||" || op === "&&";
  return (parentNullish && childLogical) || (parentLogical && childNullish);
}

function emitBinaryOperand(
  child: Expr,
  options: EmitOptions,
  minPrec: number,
  parentOp: string,
): string {
  const rendered = emitExpr(child, options, minPrec);
  if (mixesNullish(parentOp, child) && exprPrec(child) >= minPrec) {
    return `(${rendered})`;
  }
  return rendered;
}

/** Parentheses are required when a later postfix sits outside a closed optional chain. */
function emitPostfixObject(expr: Expr, options: EmitOptions): string {
  const rendered = emitExpr(expr, options, PREC_POSTFIX);
  if (
    (expr.kind === "member" || expr.kind === "index" || expr.kind === "call") &&
    expr.stopChain === true
  ) {
    return `(${rendered})`;
  }
  return rendered;
}

function emitExpr(expr: Expr, options: EmitOptions, minPrec = 0): string {
  if (expr.kind === "assert") {
    return emitExpr(expr.expression, options, minPrec);
  }

  const prec = exprPrec(expr);
  const raw = emitExprRaw(expr, options);
  if (prec < minPrec) return `(${raw})`;
  return raw;
}

function emitExprRaw(expr: Expr, options: EmitOptions): string {
  switch (expr.kind) {
    case "number":
      return expr.raw;
    case "string":
      return JSON.stringify(expr.value);
    case "boolean":
      return expr.value ? "true" : "false";
    case "null":
      return "null";
    case "undefined":
      return "undefined";
    case "ident":
      return expr.name;
    case "template": {
      let out = "`";
      for (const part of expr.parts) {
        if (part.kind === "text") {
          out += part.value
            .replace(/\\/g, "\\\\")
            .replace(/`/g, "\\`")
            .replace(/\$\{/g, "\\${");
        } else {
          out += `\${${emitExpr(part.expr, options)}}`;
        }
      }
      return `${out}\``;
    }
    case "array":
      return `[${expr.elements.map((e) => emitExpr(e, options)).join(", ")}]`;
    case "object": {
      if (expr.properties.length === 0) return "{}";
      const props = expr.properties.map((p) => {
        if (p.shorthand) return p.name;
        return `${p.name}: ${emitExpr(p.value, options)}`;
      });
      return `{ ${props.join(", ")} }`;
    }
    case "unary": {
      // Parenthesize same-prec unary so `- -1` does not become `--1`.
      const arg = emitExpr(expr.argument, options, PREC_UNARY + 1);
      if (expr.op === "typeof") return `typeof ${arg}`;
      return `${expr.op}${arg}`;
    }
    case "binary": {
      const p = binaryPrec(expr.op);
      const left = emitBinaryOperand(expr.left, options, p, expr.op);
      const right = emitBinaryOperand(expr.right, options, p + 1, expr.op);
      return `${left} ${expr.op} ${right}`;
    }
    case "assign": {
      const target = emitExpr(expr.target, options, PREC_ASSIGN + 1);
      const value = emitExpr(expr.value, options, PREC_ASSIGN);
      return `${target} = ${value}`;
    }
    case "ternary": {
      const test = emitExpr(expr.test, options, PREC_TERNARY + 1);
      const consequent = emitExpr(expr.consequent, options, PREC_TERNARY + 1);
      const alternate = emitExpr(expr.alternate, options, PREC_TERNARY);
      return `${test} ? ${consequent} : ${alternate}`;
    }
    case "call": {
      const callee = emitPostfixObject(expr.callee, options);
      const args = expr.args.map((a) => emitExpr(a, options)).join(", ");
      const op = expr.optional ? "?." : "";
      return `${callee}${op}(${args})`;
    }
    case "member": {
      const object = emitPostfixObject(expr.object, options);
      const op = expr.optional ? "?." : ".";
      return `${object}${op}${expr.property}`;
    }
    case "index": {
      const object = emitPostfixObject(expr.object, options);
      const op = expr.optional ? "?." : "";
      return `${object}${op}[${emitExpr(expr.index, options)}]`;
    }
    case "await": {
      const argument = emitExpr(expr.argument, options, PREC_UNARY + 1);
      return `await ${argument}`;
    }
    case "new": {
      const callee = emitExpr(expr.callee, options, PREC_POSTFIX);
      const args = expr.args.map((a) => emitExpr(a, options)).join(", ");
      return `new ${callee}(${args})`;
    }
    case "arrow": {
      const params = emitParams(expr.params);
      const paramList =
        expr.params.length === 1 ? params : `(${params})`;
      const asyncKw = expr.async ? "async " : "";
      if (expr.body.kind === "block") {
        return `${asyncKw}${paramList} => ${emitBlock(expr.body, options)}`;
      }
      return `${asyncKw}${paramList} => ${emitExpr(expr.body, options, PREC_ASSIGN)}`;
    }
    case "assert":
      return emitExprRaw(expr.expression, options);
    default: {
      const _exhaustive: never = expr;
      return _exhaustive;
    }
  }
}

function emitVar(stmt: VarStmt, ctx: EmitCtx, inFor = false): string {
  const { options, hoistedVars } = ctx;
  if (hoistedVars.has(stmt)) {
    if (stmt.init === null) return "";
    return `${stmt.name} = ${emitExpr(stmt.init, options)};`;
  }

  const init =
    stmt.init !== null ? ` = ${emitExpr(stmt.init, options)}` : "";
  const core = `${stmt.declKind} ${stmt.name}${init}`;
  if (inFor) return core;
  // `export default let x = …` is invalid JS; split into decl + export default.
  if (stmt.defaultExport) {
    return `${core};\nexport default ${stmt.name};`;
  }
  if (stmt.exported) return `export ${core};`;
  return `${core};`;
}

function emitFunction(stmt: FunctionDecl, ctx: EmitCtx): string {
  const prefix = stmt.defaultExport
    ? "export default "
    : stmt.exported
      ? "export "
      : "";
  const params = emitParams(stmt.params);
  const asyncKw = stmt.async ? "async " : "";
  return `${prefix}${asyncKw}function ${stmt.name}(${params}) ${emitBlock(stmt.body, ctx.options)}`;
}

function emitClass(stmt: ClassDecl, ctx: EmitCtx): string {
  const prefix = stmt.defaultExport
    ? "export default "
    : stmt.exported
      ? "export "
      : "";
  const parts: string[] = [];
  for (const m of stmt.members) {
    if (m.kind === "field") {
      parts.push(`${m.name};`);
    } else if (m.kind === "constructor") {
      parts.push(
        `constructor(${emitParams(m.params)}) ${emitBlock(m.body, ctx.options)}`,
      );
    } else {
      const asyncKw = m.async ? "async " : "";
      parts.push(
        `${asyncKw}${m.name}(${emitParams(m.params)}) ${emitBlock(m.body, ctx.options)}`,
      );
    }
  }
  const body = parts.length === 0 ? "{}" : `{\n${parts.join("\n")}\n}`;
  return `${prefix}class ${stmt.name} ${body}`;
}

function emitImport(stmt: ImportStmt, options: EmitOptions): string {
  const resolved = options.resolveImport(stmt.moduleSpecifier);
  const valueNames = stmt.names.filter((n) => resolved.isValue(n.imported));
  const keepDefault =
    stmt.defaultName !== null && resolved.hasDefault;

  if (!keepDefault && valueNames.length === 0) {
    return "";
  }

  const parts: string[] = [];
  if (keepDefault && stmt.defaultName !== null) {
    parts.push(stmt.defaultName);
  }
  if (valueNames.length > 0) {
    const named = valueNames
      .map((n) =>
        n.imported === n.local ? n.imported : `${n.imported} as ${n.local}`,
      )
      .join(", ");
    parts.push(`{ ${named} }`);
  }
  return `import ${parts.join(", ")} from ${JSON.stringify(resolved.specifier)};`;
}

/** Wrap bare function/class so strict-mode JS accepts if/while/for bodies. */
function wrapInBlock(emitted: string): string {
  return `{\n${emitted}\n}`;
}

function emitIfWhileBody(stmt: Statement, ctx: EmitCtx): string {
  if (stmt.kind === "function" || stmt.kind === "class") {
    return wrapInBlock(emitStatement(stmt, ctx));
  }
  if (stmt.kind === "var" && ctx.hoistedVars.has(stmt)) {
    const assign = emitVar(stmt, ctx);
    return assign.length > 0 ? assign : ";";
  }
  return emitStatement(stmt, ctx);
}

function emitForBody(stmt: Statement, ctx: EmitCtx): string {
  if (
    stmt.kind === "var" ||
    stmt.kind === "function" ||
    stmt.kind === "class"
  ) {
    // for has its own checker scope; do not hoist. Wrap for valid JS.
    const inner: EmitCtx = { options: ctx.options, hoistedVars: new Set() };
    return wrapInBlock(emitStatement(stmt, inner));
  }
  return emitStatement(stmt, ctx);
}

function emitStatement(stmt: Statement, ctx: EmitCtx): string {
  const { options } = ctx;
  switch (stmt.kind) {
    case "import":
      return emitImport(stmt, options);
    case "var":
      return emitVar(stmt, ctx);
    case "function":
      return emitFunction(stmt, ctx);
    case "type_alias":
    case "interface":
      return "";
    case "class":
      return emitClass(stmt, ctx);
    case "if": {
      let out = `if (${emitExpr(stmt.test, options)}) ${emitIfWhileBody(stmt.consequent, ctx)}`;
      if (stmt.alternate !== null) {
        out += ` else ${emitIfWhileBody(stmt.alternate, ctx)}`;
      }
      return out;
    }
    case "while":
      return `while (${emitExpr(stmt.test, options)}) ${emitIfWhileBody(stmt.body, ctx)}`;
    case "for": {
      let init = "";
      if (stmt.init !== null) {
        if (stmt.init.kind === "var") {
          init = emitVar(stmt.init, ctx, true);
        } else {
          init = emitExpr(stmt.init, options);
        }
      }
      const test = stmt.test !== null ? emitExpr(stmt.test, options) : "";
      const update =
        stmt.update !== null ? emitExpr(stmt.update, options) : "";
      return `for (${init}; ${test}; ${update}) ${emitForBody(stmt.body, ctx)}`;
    }
    case "return":
      if (stmt.argument === null) return "return;";
      return `return ${emitExpr(stmt.argument, options)};`;
    case "block":
      return emitBlock(stmt, options);
    case "empty":
      return ";";
    case "expr_stmt":
      return `${emitExpr(stmt.expression, options)};`;
    default: {
      const _exhaustive: never = stmt;
      return _exhaustive;
    }
  }
}

export function emitProgram(program: Program, options: EmitOptions): string {
  const lines = emitStatementList(program.body, options);
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}
