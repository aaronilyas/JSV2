import type { Diagnostic } from "../diagnostics.ts";
import type { Program } from "./ast.ts";
import { tokenize } from "./lexer.ts";
import { parseTokens } from "./parser.ts";

export function parse(
  source: string,
  file: string,
): { program: Program; diagnostics: Diagnostic[] } {
  const { tokens, diagnostics: lexerDiagnostics } = tokenize(source, file);
  return parseTokens(tokens, file, lexerDiagnostics);
}
