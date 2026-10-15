import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverEntry = join(root, "src", "mcp", "server.ts");

function parseToolJson(result: {
  content: Array<{ type: string; text?: string }>;
}): unknown {
  const block = result.content[0];
  assert.ok(block !== undefined);
  assert.equal(block.type, "text");
  assert.ok(typeof block.text === "string");
  return JSON.parse(block.text);
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

test("MCP stdio server tools and exit on client close", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["--experimental-strip-types", serverEntry],
    cwd: root,
    stderr: "pipe",
  });
  const client = new Client({ name: "jsv2-test", version: "0.0.0" });
  let pid: number | null = null;
  try {
    await client.connect(transport);
    pid = transport.pid;
    assert.ok(pid !== null && pid > 0);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "check",
      "domAnalyze",
      "suggestFix",
      "typeOf",
    ]);

    const badCheck = parseToolJson(
      await client.callTool({
        name: "check",
        arguments: { source: "let x: string = 1;" },
      }),
    ) as { ok: boolean; diagnostics: { code: string }[] };
    assert.equal(badCheck.ok, false);
    assert.ok(
      badCheck.diagnostics.some((d) => d.code === "jsv.check.not_assignable"),
    );

    const goodCheck = parseToolJson(
      await client.callTool({
        name: "check",
        arguments: { source: "let x: number = 1;" },
      }),
    ) as { ok: boolean };
    assert.equal(goodCheck.ok, true);

    const typeOf = parseToolJson(
      await client.callTool({
        name: "typeOf",
        arguments: {
          source: "let count: number = 1; count;",
          line: 1,
          column: 24,
        },
      }),
    ) as { found: boolean; type?: string };
    assert.equal(typeOf.found, true);
    assert.equal(typeOf.type, "number");

    const fix = parseToolJson(
      await client.callTool({
        name: "suggestFix",
        arguments: {
          source: "let x: number = 1\nlet y: number = 2;\n",
          code: "jsv.parse.unexpected_token",
          line: 2,
          column: 1,
        },
      }),
    ) as { applicable: boolean; edits: unknown[] };
    assert.equal(fix.applicable, true);
    assert.equal(fix.edits.length, 1);

    const dom = parseToolJson(
      await client.callTool({
        name: "domAnalyze",
        arguments: {
          source: `import { signal, effect } from "jsv/dom";
let count = signal<number>(0);
effect(() => {
  count.set(count.get() + 1);
});
`,
        },
      }),
    ) as { effects: unknown[]; issues: { code: string }[] };
    assert.equal(dom.effects.length, 1);
    assert.ok(
      dom.issues.some((i) => i.code === "jsv.dom.effect_self_write"),
    );
  } finally {
    await client.close();
  }

  assert.ok(pid !== null);
  const exited = await waitForExit(pid!, 2000);
  assert.equal(exited, true, `server pid ${pid} still alive after client.close`);
});
