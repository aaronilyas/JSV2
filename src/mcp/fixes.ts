import {
  checkSource,
  type CheckOptions,
} from "../checker/check.ts";
import type { Diagnostic, SourcePosition } from "../diagnostics.ts";

export type TextEdit = {
  start: SourcePosition;
  end: SourcePosition;
  newText: string;
};

export function suggestFix(
  source: string,
  file: string,
  code: string,
  line: number,
  column: number,
  options?: CheckOptions,
): {
  applicable: boolean;
  edits: TextEdit[];
  message: string;
  diagnostics: Diagnostic[];
} {
  const { diagnostics } = checkSource(source, file, options);
  const match = diagnostics.find(
    (d) =>
      d.code === code &&
      d.start !== undefined &&
      d.start.line === line &&
      d.start.column === column,
  );

  if (match === undefined) {
    return {
      applicable: false,
      edits: [],
      message: "No matching diagnostic at that position.",
      diagnostics,
    };
  }

  if (
    match.code === "jsv.parse.unexpected_token" &&
    match.message.includes("expected `;`") &&
    match.start !== undefined
  ) {
    return {
      applicable: true,
      edits: [
        {
          start: match.start,
          end: match.start,
          newText: ";",
        },
      ],
      message: "Insert `;` before the unexpected token.",
      diagnostics,
    };
  }

  return {
    applicable: false,
    edits: [],
    message: `Diagnostic code '${code}' is not auto-fixable.`,
    diagnostics,
  };
}
