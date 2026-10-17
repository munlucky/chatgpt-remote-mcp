import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { McpToolError } from "../src/errors.js";
import { requestMetrics, type RequestMetrics, UsageLog, type UsageEvent } from "../src/telemetry.js";
import { runTool } from "../src/tool-result.js";

it("records typed failure codes while SDK validation never becomes successful tool execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-codes-"));
  const config = loadConfig({ MCP_AUTH_TOKEN: "sentinel-auth", MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: path.join(root, "state"), MCP_USAGE_LOG_DIR: path.join(root, "usage") }, root);
  config.host = "127.0.0.1"; config.port = 0;
  const services = createServices(config), server = await startHttpServer(config, services);
  try {
    await writeFile(path.join(root, "sentinel-file"), "sentinel-content");
    const endpoint = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
    const call = (name: string, args: Record<string, unknown>) => fetch(endpoint, {
      method: "POST", headers: { authorization: "Bearer sentinel-auth", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }).then(r => r.json());
    await call("replace_in_file", { path: "sentinel-file", oldText: "sentinel-not-found", newText: "new" });
    await call("apply_patch", { patch: "sentinel-invalid-patch", cwd: root });
    await call("read_process", { sessionId: randomUUID() });
    const invalid = await call("read_file", { path: 123 });
    expect(invalid.result.isError).toBe(true);
    await services.usageLog.flush();
    const raw = await readFile(path.join(root, "usage", "requests.jsonl"), "utf8");
    expect(raw).not.toContain("sentinel-"); expect(raw).not.toContain(root);
    const events = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(events.map(e => e.errorCode)).toEqual(["replacement_mismatch", "patch_check_failed", "process_session_unknown", undefined]);
    expect(events.at(-1).toolError).toBeNull();
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

it("allowlists arbitrary error codes without inferring cause from a message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-safe-code-"));
  const log = new UsageLog(root, 4096, 2);
  try {
    for (const error of [new Error("file missing permission denied sentinel-secret"), new McpToolError("sentinel-secret", "sentinel-message")]) {
      const metrics: RequestMetrics = { setupMs: null, toolMs: null, toolError: null };
      await requestMetrics.run(metrics, () => runTool(() => { throw error; }));
      expect(metrics).toMatchObject({ toolError: true, errorCategory: "tool_failure", errorCode: "other" });
    }
    log.record({ event: "mcp_request", errorCode: "sentinel-secret" } as UsageEvent);
    await log.flush();
    const raw = await readFile(path.join(root, "requests.jsonl"), "utf8");
    expect(raw).toContain('"errorCode":"other"'); expect(raw).not.toContain("sentinel");
  } finally { await log.flush(); await rm(root, { recursive: true, force: true }); }
});
