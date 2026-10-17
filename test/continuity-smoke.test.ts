import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";

it("runs the deployment terminal smoke through HTTP tools in a disposable workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-smoke-test-"));
  const config = loadConfig({ MCP_AUTH_TOKEN: "synthetic", MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: path.join(root, "state") }, root);
  config.host = "127.0.0.1"; config.port = 0;
  const services = createServices(config), server = await startHttpServer(config, services);
  try {
    const { verifyContinuitySmoke } = await import("../scripts/" + "continuity-smoke.mjs");
    const endpoint = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
    const result = await verifyContinuitySmoke(async (name: string, args: Record<string, unknown>) => {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      const body = await response.json();
      expect(response.status).toBe(200); expect(body.result.isError, JSON.stringify(body.result.structuredContent ?? body.result.content)).not.toBe(true);
      return { data: body.result.structuredContent };
    });
    expect(result).toMatchObject({ terminalSmokeVerified: true, syntheticExecutions: 3, syntheticTimeouts: 1, terminalReplayVerified: true });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
