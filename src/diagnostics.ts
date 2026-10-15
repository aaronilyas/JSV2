export type SourcePosition = { line: number; column: number };

export type Diagnostic = {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  start?: SourcePosition;
  end?: SourcePosition;
  hint?: string;
};

export function formatDiagnosticsText(
  diagnostics: readonly Diagnostic[],
): string {
  return diagnostics
    .map((d) => {
      const prefix = d.file !== undefined ? `${d.file}: ` : "";
      return `${prefix}${d.severity}: ${d.code}: ${d.message}`;
    })
    .join("\n");
}

export function diagnosticsResult(
  diagnostics: readonly Diagnostic[],
): { ok: boolean; diagnostics: Diagnostic[] } {
  return {
    ok: diagnostics.length === 0,
    diagnostics: [...diagnostics],
  };
}
