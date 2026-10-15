type GoConstructor = new () => {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
};

export type WasmAssets = {
  wasmURL: string;
  execURL: string;
};

function configuredAssets(): WasmAssets | null {
  const assets = (globalThis as { __jsvWasmAssets?: WasmAssets }).__jsvWasmAssets;
  if (assets === undefined) return null;
  if (typeof assets.wasmURL !== "string" || typeof assets.execURL !== "string") {
    throw new Error("globalThis.__jsvWasmAssets requires wasmURL and execURL strings");
  }
  return assets;
}

function defaultAssets(): WasmAssets {
  return {
    wasmURL: new URL("../../runtime/wasm/jsv.wasm", import.meta.url).href,
    execURL: new URL("../../runtime/wasm/wasm_exec.js", import.meta.url).href,
  };
}

function evalClassicScript(source: string): void {
  // wasm_exec.js is a classic script (not an ES module). It assigns globalThis.Go.
  const run = new Function(source);
  run();
}

/**
 * Fetch Go's wasm_exec.js and instantiate jsv.wasm.
 * Uses instantiateStreaming when the response is application/wasm.
 * No Node built-ins: this is the browser (and other fetch hosts) path.
 */
export async function instantiateFromURLs(
  wasmURL: string,
  execURL: string,
): Promise<void> {
  const execRes = await fetch(execURL);
  if (!execRes.ok) {
    throw new Error(
      `failed to fetch wasm_exec.js (${execRes.status}) from ${execURL}`,
    );
  }
  evalClassicScript(await execRes.text());

  const Go = (globalThis as { Go?: GoConstructor }).Go;
  if (Go === undefined) {
    throw new Error("globalThis.Go was not set by wasm_exec.js");
  }

  const ready = new Promise<void>((resolve) => {
    (globalThis as { __jsvWasmReady?: () => void }).__jsvWasmReady = () => {
      resolve();
    };
  });

  const go = new Go();
  const wasmRes = await fetch(wasmURL);
  if (!wasmRes.ok) {
    throw new Error(`failed to fetch jsv.wasm (${wasmRes.status}) from ${wasmURL}`);
  }

  const contentType = wasmRes.headers.get("Content-Type") ?? "";
  let instance: WebAssembly.Instance;
  if (
    typeof WebAssembly.instantiateStreaming === "function" &&
    contentType.toLowerCase().includes("application/wasm")
  ) {
    const streamed = await WebAssembly.instantiateStreaming(
      wasmRes,
      go.importObject,
    );
    instance = streamed.instance;
  } else {
    const bytes = await wasmRes.arrayBuffer();
    const compiled = await WebAssembly.instantiate(bytes, go.importObject);
    instance = compiled.instance;
  }

  // Do not await: go.run resolves only when the Go program exits.
  void go.run(instance);
  await ready;
}

/** Browser loader. One call per page; the singleton lives in wasm-load.ts. */
export async function loadBrowserWasm(): Promise<void> {
  const assets = configuredAssets() ?? defaultAssets();
  await instantiateFromURLs(assets.wasmURL, assets.execURL);
}
