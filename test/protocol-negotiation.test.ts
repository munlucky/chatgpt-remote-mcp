import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SUPPORTED_PROTOCOL_VERSIONS, LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";

it("preserves installed SDK negotiation and rejects unsupported follow-up headers without side effects or raw logs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-protocol-"));
  const config = loadConfig({ MCP_AUTH_TOKEN: "sentinel-auth", MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: path.join(root, "state"), MCP_USAGE_LOG_DIR: path.join(root, "usage") }, root);
  config.host = "127.0.0.1"; config.port = 0;
  const services = createServices(config), server = await startHttpServer(config, services);
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const endpoint = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
    let id = 0;
    const post = (method: string, params: Record<string, unknown>, version?: string) => fetch(endpoint, {
      method: "POST", headers: { authorization: "Bearer sentinel-auth", "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(version ? { "mcp-protocol-version": version } : {}) },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const init = (version: string) => post("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name: "synthetic", version: "1" } });
    for (const requested of [...SUPPORTED_PROTOCOL_VERSIONS, "sentinel-unsupported-initialize"]) {
      const response = await init(requested);
      expect(response.status).toBe(200);
      const negotiated = (await response.json()).result.protocolVersion;
      expect(negotiated).toBe(SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION);
      const listing = await post("tools/list", {}, negotiated);
      expect(listing.status).toBe(200);
      const catalog = (await listing.json()).result.tools;
      expect(catalog).toHaveLength(25);
      expect(catalog.find((t: { name: string }) => t.name === "complete_work").inputSchema.properties.finalCheckpoint.properties.current.maxLength).toBe(2048);
    }
    const rejected = await post("tools/call", { name: "write_file", arguments: { path: "sentinel-side-effect", content: "sentinel-content" } }, "sentinel-unsupported-header");
    expect(rejected.status).toBe(400);
    await expect(access(path.join(root, "sentinel-side-effect"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await post("tools/list", {})).status).toBe(200);
    await services.usageLog.flush();
    const raw = await readFile(path.join(root, "usage", "requests.jsonl"), "utf8");
    expect(raw).not.toContain("sentinel"); expect(raw).not.toContain(root);
    expect(JSON.stringify(errors.mock.calls)).not.toContain("sentinel");
    const events = raw.trim().split("\n").map(line => JSON.parse(line));
    expect(events.find(e => e.protocolHeader === "unsupported")).toMatchObject({ status: 400, toolError: null });
    expect(events.find(e => e.initializeProtocol === "unsupported")).toMatchObject({ status: 200, protocolHeader: "omitted" });
    expect(events.at(-1)).toMatchObject({ protocolHeader: "omitted", status: 200 });
  } finally { errors.mockRestore(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
