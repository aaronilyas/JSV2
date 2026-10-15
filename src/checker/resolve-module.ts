import { dirname, extname, resolve } from "node:path";

const ALT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

export type SpecifierCandidates =
  | { kind: "relative"; candidates: string[] }
  | { kind: "unsupported" };

/** Relative specifiers agents write, rewritten to `.jsv` candidates. */
export function specifierCandidates(specifier: string): SpecifierCandidates {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return { kind: "unsupported" };
  }
  if (specifier.endsWith(".jsv")) {
    return { kind: "relative", candidates: [specifier] };
  }
  const ext = extname(specifier);
  if (ALT_EXTENSIONS.includes(ext)) {
    return {
      kind: "relative",
      candidates: [`${specifier.slice(0, -ext.length)}.jsv`],
    };
  }
  if (ext.length === 0) {
    return {
      kind: "relative",
      candidates: [`${specifier}.jsv`, `${specifier}/index.jsv`],
    };
  }
  return { kind: "relative", candidates: [] };
}

export function unresolvedModuleMessage(specifier: string): {
  message: string;
  hint: string;
} {
  const hint =
    'Import a relative .jsv path such as "./mod.jsv", or the ambient module "jsv/dom".';
  const found = specifierCandidates(specifier);
  if (found.kind === "unsupported") {
    return {
      message: `Cannot resolve module '${specifier}'. Bare specifiers are not supported.`,
      hint,
    };
  }
  if (found.candidates.length === 0) {
    return {
      message: `Cannot resolve module '${specifier}'. Only .jsv modules can be imported.`,
      hint,
    };
  }
  if (specifier.endsWith(".jsv")) {
    return {
      message: `Module not found: '${specifier}'.`,
      hint,
    };
  }
  const looked = found.candidates.map((c) => `'${c}'`).join(" or ");
  return {
    message: `Module not found: '${specifier}'. Looked for ${looked}.`,
    hint: `Use a .jsv specifier, for example ${found.candidates[0]}.`,
  };
}

export function resolveExistingModule(
  fromFile: string,
  specifier: string,
  exists: (absolute: string) => boolean,
): { absolute: string } | null {
  const found = specifierCandidates(specifier);
  if (found.kind !== "relative") return null;
  for (const candidate of found.candidates) {
    const absolute = resolve(dirname(fromFile), candidate);
    if (exists(absolute)) return { absolute };
  }
  return null;
}
