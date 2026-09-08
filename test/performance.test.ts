import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { UsageLog, type UsageEvent } from "../src/telemetry.js";
import { readFiles } from "../src/batch-read.js";

describe("performance and usage contracts", () => {
  it("keeps list semantics and ordered bounded batch results", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-perf-"));
    const services = createServices(loadConfig({ MCP_AUTH_TOKEN: "test", MCP_DEFAULT_CWD: dir }));
    try {
      await mkdir(path.join(dir, "child"));
      await writeFile(path.join(dir, "child", "a"), "가나다");
      await writeFile(path.join(dir, ".hidden"), "secret");
      if (process.platform !== "win32") await symlink("child", path.join(dir, "link"));
      const fast = await services.fileService.listDirectory(".", undefined, { recursive: true });
      const detailed = await services.fileService.listDirectory(".", undefined, { recursive: true, includeMetadata: true });
      expect(fast.entries).toEqual((detailed.entries as Record<string, unknown>[]).map(({ size, mode, modifiedAt, ...rest }) => rest));
      expect((fast.entries as { relativePath: string }[]).some(e => e.relativePath.startsWith(`link${path.sep}`))).toBe(false);
      const limited = await services.fileService.listDirectory(".", undefined, { maxEntries: 1 });
      expect(limited.count).toBe(1); expect(limited.truncated).toBe(true);
      const batch = await readFiles(services.fileService, ["child/a", "missing", ".hidden"], undefined, 4);
      expect(batch.files[0]?.content).toBe("가");
      expect(batch.files[0]?.nextOffset).toBe(3);
      expect(batch.files[1]?.error).toBeTypeOf("string");
      expect(batch.files[2]?.content).toBe("secr");
    } finally { await services.processManager.shutdown(); await rm(dir, { recursive: true, force: true }); }
  });

  it("records metadata, byte counts and tool errors without secrets or bodies", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-log-"));
    const config = loadConfig({ MCP_AUTH_TOKEN: "never-log-this-token", MCP_DEFAULT_CWD: dir, MCP_USAGE_LOG_DIR: path.join(dir, "usage"), MCP_BUILD_ID: "test-build" });
    config.port = 0; config.host = "127.0.0.1";
    const services = createServices(config);
    const server = await startHttpServer(config, services);
    const url = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
    try {
      const call = async (name: string, args: Record<string, unknown>, auth = true) => {
        const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(auth ? { authorization: "Bearer never-log-this-token" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        const body = await response.text();
        return { response, body };
      };
      const good = await call("read_files", { paths: ["never-log-this-path"] });
      expect(good.response.status).toBe(200);
      await call("read_file", { path: "never-log-this-path" });
      await call("never-log-this-tool", {});
      expect((await call("read_file", {}, false)).response.status).toBe(401);
      await server.close();
      const raw = await readFile(path.join(dir, "usage", "requests.jsonl"), "utf8");
      expect(raw).not.toContain("never-log-this");
      const events = raw.trim().split("\n").map(line => JSON.parse(line));
      expect(events).toHaveLength(4);
      expect(events[0].responseBytes).toBe(Buffer.byteLength(good.body));
      expect(events[0].setupMs).toBeGreaterThanOrEqual(0);
      expect(events[0].toolMs).toBeGreaterThanOrEqual(0);
      expect(events[1].toolError).toBe(true);
      expect(events[2].toolName).toBe("other");
      expect(events[3].status).toBe(401);
    } finally { await server.close().catch(() => {}); await rm(dir, { recursive: true, force: true }); }
  });

  it("rotates within the byte/file budget and survives reopening", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-rotate-"));
    const event: UsageEvent = { event: "mcp_request", timestamp: new Date().toISOString(), requestId: "test", buildId: "test", httpMethod: "POST", rpcMethod: "tools/call", toolName: "read_file", status: 200, outcome: "completed", durationMs: 1, setupMs: 0.1, toolMs: 0.2, toolError: false, responseBytes: 20 };
    try {
      for (let round = 0; round < 2; round++) {
        const log = new UsageLog(dir, 1024, 3);
        for (let i = 0; i < 20; i++) log.record(event);
        await log.flush(); expect(log.writeFailures).toBe(0);
      }
      const files = await readdir(dir); expect(files).toHaveLength(3);
      for (const file of files) expect((await readFile(path.join(dir, file))).length).toBeLessThanOrEqual(1024);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
