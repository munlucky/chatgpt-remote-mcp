import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { ProcessManager } from "../src/process-manager.js";

it("validates configurable yield without changing its compatibility default", () => {
  expect(loadConfig({ MCP_AUTH_TOKEN: "test" }).defaultProcessYieldMs).toBe(750);
  expect(loadConfig({ MCP_AUTH_TOKEN: "test", MCP_DEFAULT_PROCESS_YIELD_MS: "3000" }).defaultProcessYieldMs).toBe(3000);
  for (const value of ["-1","30001","0.5","NaN"]) expect(() => loadConfig({ MCP_AUTH_TOKEN: "test", MCP_DEFAULT_PROCESS_YIELD_MS: value })).toThrow("MCP_DEFAULT_PROCESS_YIELD_MS");
});

it("terminal waits ignore output, honor budgets and keep bounded cursor reads", async () => {
  const manager = new ProcessManager({ maxRetainedOutputBytes: 1024*1024, maxTotalRetainedOutputBytes: 1024*1024,
    processRetentionMs: 60_000, maxProcesses: 16, maxRunningProcesses: 16, defaultReadOutputBytes: 16384, maxReadOutputBytes: 32768 });
  const start = (delay: number) => manager.start({ executable: process.execPath,
    args: ["-e", `process.stdout.write('a'.repeat(40000));setTimeout(()=>process.stdout.write('end'),${delay})`], commandForDisplay: "test", cwd: process.cwd() });
  try {
    const first = await manager.read(start(300), { waitMs: 2000, waitMode: "output" });
    expect(first.running).toBe(true); expect(first.output.length).toBeGreaterThan(0);
    const sessionId = start(300);
    const terminal = await manager.read(sessionId, { waitMs: 2000, waitMode: "terminal", maxOutputBytes: 16384 });
    expect(terminal).toMatchObject({ running: false, exitCode: 0, hasMore: true });
    let output = terminal.output, result = terminal;
    while (result.hasMore) {
      result = await manager.read(sessionId, { afterSeq: result.nextSeq, waitMode: "terminal", waitMs: 1000, maxOutputBytes: 16384 });
      output += result.output;
    }
    expect(output).toBe("a".repeat(40000)+"end");
    const budget = await manager.read(start(500), { waitMs: 100, waitMode: "terminal" });
    expect(budget.running).toBe(true);
    expect(budget.output.length).toBeGreaterThan(0);
  } finally { await manager.shutdown(); }
});

it("suppresses only safe durable guidance and keeps retry identity and failure recovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-controls-"));
  const config = loadConfig({ MCP_AUTH_TOKEN: "test", MCP_DEFAULT_CWD: root, MCP_DEFAULT_PROCESS_YIELD_MS: "3000",
    MCP_CONTINUITY_STATE_DIR: path.join(root,"state") }, root);
  config.port = 0; config.host = "127.0.0.1";
  const services = createServices(config), server = await startHttpServer(config, services);
  const call = async (name: string, args: Record<string,unknown>) => {
    const response = await fetch(`http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`, {
      method: "POST", headers: { authorization: "Bearer test", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const body = await response.json(); expect(body.result.isError).not.toBe(true); return body.result;
  };
  try {
    const task = await services.continuityService.create({ cwd: root, requestId: randomUUID(), objective: "test",
      checkpoint: { phase: "test", completed: [], current: "test", remaining: [], blockers: [], evidenceRefs: [], changedPaths: [] } });
    const args = { taskId: task.taskId, operationId: randomUUID(), runtime: "node",
      script: "import{appendFileSync}from'node:fs';appendFileSync('effects','once\\n');console.log('ok')" };
    const safe = await call("run_script", args);
    expect(safe.structuredContent).toMatchObject({ running: false, hasMore: false, executionState: "exited", persistenceState: "ok", exitCode: 0 });
    expect(safe.structuredContent).not.toHaveProperty("nextCall");
    expect(JSON.parse(safe.content[0].text.split("\n")[0])).not.toHaveProperty("nextCall");
    const replay = await call("run_script", { ...args, yieldTimeMs: 0 });
    expect(replay.structuredContent).toMatchObject({ duplicate: true, sessionId: safe.structuredContent.sessionId });
    expect(await readFile(path.join(root,"effects"),"utf8")).toBe("once\n");
    const failed = await call("run_script", { ...args, operationId: randomUUID(), script: "process.exit(7)" });
    expect(failed.structuredContent.nextCall.tool).toBe("get_work_context");
    const large = await call("run_script", { ...args, operationId: randomUUID(), script: "process.stdout.write('x'.repeat(40000))", maxOutputBytes: 16384 });
    expect(large.structuredContent).toMatchObject({ hasMore: true, nextCall: { tool: "read_process" } });
    const read = services.executionRecorder.store.readExecution.bind(services.executionRecorder.store);
    const spy = vi.spyOn(services.executionRecorder.store,"readExecution").mockImplementation(async (...input) => {
      const receipt = await read(...input); return receipt ? { ...receipt, persistenceState: "degraded" } : null;
    });
    const degraded = await call("read_process", { sessionId: safe.structuredContent.sessionId, waitMode: "terminal" });
    expect(degraded.structuredContent.nextCall.tool).toBe("get_work_context"); spy.mockRestore();
  } finally { vi.restoreAllMocks(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
