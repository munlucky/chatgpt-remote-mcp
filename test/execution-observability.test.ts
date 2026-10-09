import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";

describe("request-independent execution observation", () => {
  it("records a failed process after its HTTP response ends, without polling or sensitive payloads", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-execution-log-"));
    const config = loadConfig({ MCP_AUTH_TOKEN: "private-auth", MCP_DEFAULT_CWD: dir, MCP_USAGE_LOG_DIR: path.join(dir, "usage") });
    config.port = 0; config.host = "127.0.0.1";
    const services = createServices(config);
    const server = await startHttpServer(config, services);
    const endpoint = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
    try {
      const response = await fetch(endpoint, {
        method: "POST", headers: { authorization: "Bearer private-auth", "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "openai-mcp/1.0.0 (Codex)" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "exec_command", arguments: {
          cmd: "node -e \"setTimeout(() => { console.log('private-output'); process.exit(7); }, 200)\"", yieldTimeMs: 0,
        } } }),
      });
      const body = await response.json() as { result: { structuredContent: { sessionId: string; running: boolean } } };
      expect(body.result.structuredContent.running).toBe(true);
      await services.processManager.waitForExit(body.result.structuredContent.sessionId, 3000);
      await services.usageLog.flush();
      const raw = await readFile(path.join(dir, "usage", "requests.jsonl"), "utf8");
      expect(raw).not.toContain("private-");
      expect(raw).not.toContain(dir);
      const events = raw.trim().split("\n").map(line => JSON.parse(line));
      const request = events.find(e => e.event === "mcp_request");
      const started = events.filter(e => e.event === "process_started");
      const terminal = events.filter(e => e.event === "process_terminal");
      expect(request).toMatchObject({ status: 200, toolError: false, clientClass: "codex" });
      expect(started).toHaveLength(1); expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ requestId: request.requestId, sessionId: body.result.structuredContent.sessionId, exitCode: 7, timedOut: false, trafficClass: "usage", clientClass: "codex", bootId: started[0].bootId });
      const report = JSON.parse(execFileSync(process.execPath, ["scripts/usage-report.mjs", path.join(dir, "usage"), "24"], { encoding: "utf8" }));
      expect(report).toMatchObject({ samples: 1, executions: { started: 1, terminal: 1, failed: 1, succeeded: 0, withoutTerminalInWindow: 0 } });
    } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps probe execution separate and classifies a missing file without logging its path", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-probe-execution-"));
    const config = loadConfig({ MCP_AUTH_TOKEN: "private-auth", MCP_PROBE_SECRET: "private-probe", MCP_DEFAULT_CWD: dir, MCP_USAGE_LOG_DIR: path.join(dir, "usage") });
    config.port = 0; config.host = "127.0.0.1";
    const services = createServices(config);
    const server = await startHttpServer(config, services);
    const endpoint = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
    const call = async (name: string, args: Record<string, unknown>, probe: boolean) => {
      const response = await fetch(endpoint, { method: "POST", headers: { authorization: "Bearer private-auth", "content-type": "application/json", accept: "application/json, text/event-stream", ...(probe ? { "x-mcp-probe-secret": "private-probe" } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      return response.json();
    };
    try {
      await call("run_script", { runtime: "node", script: "process.exit(0)", yieldTimeMs: 3000 }, true);
      await call("read_file", { path: "private-missing-path" }, false);
      await services.usageLog.flush();
      const raw = await readFile(path.join(dir, "usage", "requests.jsonl"), "utf8");
      expect(raw).not.toContain("private-");
      const events = raw.trim().split("\n").map(line => JSON.parse(line));
      expect(events.find(e => e.event === "process_terminal")).toMatchObject({ trafficClass: "probe", exitCode: 0 });
      expect(events.find(e => e.toolName === "read_file")).toMatchObject({ toolError: true, errorCategory: "file_missing" });
      const report = JSON.parse(execFileSync(process.execPath, ["scripts/usage-report.mjs", path.join(dir, "usage"), "24"], { encoding: "utf8" }));
      expect(report).toMatchObject({ samples: 1, executions: { started: 0, terminal: 0, failed: 0 } });
    } finally { await server.close(); await rm(dir, { recursive: true, force: true }); }
  });

  it("uses explicit day boundaries and does not label incomplete lifecycle coverage as failure", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mcp-day-report-"));
    const since = "2026-10-09T00:00:00+09:00", until = "2026-10-10T00:00:00+09:00";
    const request = { event: "mcp_request", buildId: "test", toolName: "read_file", durationMs: 1, status: 200 };
    try {
      await writeFile(path.join(dir, "requests.jsonl"), [
        { ...request, timestamp: "2026-10-08T14:59:59Z", clientClass: "codex" },
        { ...request, timestamp: "2026-10-08T15:00:00Z", clientClass: "codex" },
        { ...request, timestamp: "2026-10-09T01:00:00Z", clientClass: "openai_mcp" },
        { ...request, timestamp: "2026-10-09T02:00:00Z" },
        { ...request, timestamp: "2026-10-09T15:00:00Z", clientClass: "codex" },
        { event: "process_started", timestamp: "2026-10-09T03:00:00Z", bootId: "boot", sessionId: "session" },
      ].map(e => JSON.stringify(e)).join("\n"));
      const report = JSON.parse(execFileSync(process.execPath, ["scripts/usage-report.mjs", dir, "--since", since, "--until", until], { encoding: "utf8" }));
      expect(report.samples).toBe(3);
      expect(report.groups.map((g: { clientClass: string }) => g.clientClass).sort()).toEqual(["codex", "legacy_unknown", "openai_mcp"]);
      expect(report.executions).toMatchObject({ started: 1, terminal: 0, failed: 0, withoutTerminalInWindow: 1 });
      expect(report.period).toEqual({ since: "2026-10-08T15:00:00.000Z", until: "2026-10-09T15:00:00.000Z" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
