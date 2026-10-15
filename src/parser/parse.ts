import type { Diagnostic } from "../diagnostics.ts";
import type { Program } from "./ast.ts";
import { createLexer } from "./lexer.ts";
import { parseProgram } from "./parser.ts";

export function parse(
  source: string,
  file: string,
): { program: Program; diagnostics: Diagnostic[] } {
  return parseProgram(createLexer(source, file));
}
