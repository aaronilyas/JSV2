import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const browserPath = path.join(root, "src", "runtime", "wasm-browser.ts");
const raw = readFileSync(browserPath, "utf8");
if (/\bnode:|readFileSync|createRequire|from ["']fs["']|require\(/.test(raw)) {
  console.error("browser loader references Node built-ins");
  process.exit(1);
}

const dir = path.join(root, "runtime", "wasm");
const wasmBytes = readFileSync(path.join(dir, "jsv.wasm"));
const execSource = readFileSync(path.join(dir, "wasm_exec.js"), "utf8");
if (/\brequire\(/.test(execSource)) {
  console.error("wasm_exec.js is not browser-loadable");
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.url === "/jsv.wasm") {
    res.setHeader("Content-Type", "application/wasm");
    res.end(wasmBytes);
    return;
  }
  if (req.url === "/wasm_exec.js") {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.end(execSource);
    return;
  }
  res.statusCode = 404;
  res.end("missing");
});

await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve());
});

try {
  const addr = server.address();
  if (addr === null || typeof addr === "string") {
    throw new Error("test server has no port");
  }
  const base = `http://127.0.0.1:${addr.port}`;
  let usedStreaming = false;

  const sandbox = {
    console,
    fetch: globalThis.fetch,
    URL,
    crypto: globalThis.crypto,
    performance: globalThis.performance,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint8ClampedArray,
    DataView,
    ArrayBuffer,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    setInterval,
    clearInterval,
    WebAssembly: {
      Module: WebAssembly.Module,
      Instance: WebAssembly.Instance,
      compile: WebAssembly.compile,
      instantiate: WebAssembly.instantiate,
      compileStreaming: WebAssembly.compileStreaming,
      instantiateStreaming(source, imports) {
        usedStreaming = true;
        return WebAssembly.instantiateStreaming(source, imports);
      },
    },
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  const stripped = stripTypeScriptTypes(raw, { mode: "strip" });
  const mod = new vm.SourceTextModule(stripped, {
    context,
    identifier: browserPath,
  });
  await mod.link(() => {
    throw new Error("browser loader must not import other modules");
  });
  await mod.evaluate();
  const instantiate = mod.namespace.instantiateFromURLs;
  if (typeof instantiate !== "function") {
    throw new Error("instantiateFromURLs was not exported");
  }
  await instantiate(`${base}/jsv.wasm`, `${base}/wasm_exec.js`);
  if (!usedStreaming) {
    throw new Error("WebAssembly.instantiateStreaming was not used");
  }

  const rt = sandbox.jsvRuntime;
  if (rt === undefined || rt.backend() !== "wasm") {
    throw new Error(`backend ${rt && rt.backend && rt.backend()}`);
  }
  const id = rt.signalNew(7);
  rt.signalSet(id, 9);
  if (rt.signalGet(id) !== 9) {
    throw new Error(`signal roundtrip got ${rt.signalGet(id)}`);
  }
  if (sandbox.process?.versions?.node !== undefined) {
    throw new Error("sandbox received Node's process");
  }
} finally {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
