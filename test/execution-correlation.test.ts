import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { serializeUsageEvent } from "../src/telemetry-schema.js";
import type { UsageEvent } from "../src/telemetry.js";

it("removes unexpected runtime properties and validates nested metadata", () => {
  const raw = serializeUsageEvent({ event: "mcp_request", requestId: randomUUID(), timestamp: new Date().toISOString(),
    cmd: "private-command", output: "private-output", cwd: "/private/path", errorCode: "/private/error",
    correlation: { taskId: "/private/task", workspaceId: "/private/workspace", secret: "private-nested" },
    processRead: { running: true, hasMore: false, outputBytes: 0, droppedOutputBytes: 0, stdout: "private-stdout" },
  } as unknown as UsageEvent);
  expect(JSON.stringify(raw)).not.toContain("private");
  expect(raw).toMatchObject({ schemaVersion: 2, correlation: { taskId: null, workspaceId: null }, processRead: { outputBytes: 0 } });
});

it("keeps concurrent tasks separate and uses service-selected context/checkpoint bindings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-correlation-"));
  const config = loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: path.join(root,"state"), MCP_USAGE_LOG_DIR: path.join(root,"usage") }, root);
  config.port = 0; config.host = "127.0.0.1";
  const services = createServices(config), server = await startHttpServer(config, services);
  const endpoint = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
    const response = await fetch(endpoint, { method: "POST", signal,
      headers: { authorization: "Bearer secret", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    return { requestId: response.headers.get("x-request-id"), ...(await response.json()).result };
  };
  try {
    const checkpoint = { phase: "work", completed: [], current: "test", remaining: [], blockers: [], evidenceRefs: [], changedPaths: [] };
    const { mkdir } = await import("node:fs/promises");
    const workspaces = [path.join(root,"a"), path.join(root,"b")];
    await Promise.all(workspaces.map(w => mkdir(w)));
    const tasks = await Promise.all(workspaces.map(cwd => call("checkpoint_work", { mode: "create", cwd, requestId: randomUUID(), objective: "test", checkpoint })));
    const executions = await Promise.all(tasks.map((task, i) => call("run_script", {
      taskId: task.structuredContent.taskId, operationId: randomUUID(), runtime: "node", workdir: workspaces[i],
      script: "setTimeout(()=>console.log('private-output'),100)", yieldTimeMs: 3000,
    })));
    await Promise.all(tasks.map(task => call("get_work_context", { taskId: task.structuredContent.taskId })));
    await call("run_script", { taskId: randomUUID(), operationId: randomUUID(), runtime: "node", script: "private-code" });
    await services.usageLog.flush();
    const raw = await readFile(path.join(root,"usage","requests.jsonl"),"utf8");
    expect(raw).not.toContain("private"); expect(raw).not.toContain(root);
    const events = raw.trim().split("\n").map(s => JSON.parse(s));
    for (const [i, task] of tasks.entries()) {
      const c = task.structuredContent;
      const lifecycle = events.filter(e => e.event.startsWith("process_") && e.correlation.taskId === c.taskId);
      expect(lifecycle).toHaveLength(2);
      const req = events.find(e => e.requestId === executions[i].requestId && e.event === "mcp_request");
      expect(req.correlation).toMatchObject({ taskId: c.taskId, workspaceId: c.workspaceId,
        executionBootId: lifecycle[0].bootId, sessionId: lifecycle[0].sessionId });
      expect(events.find(e => e.toolName === "get_work_context" && e.correlation.taskId === c.taskId)).toBeTruthy();
      expect(events.find(e => e.requestId === task.requestId).correlation).toMatchObject({ taskId: c.taskId, workspaceId: c.workspaceId });
    }
    expect(events.find(e => e.toolError === true).correlation).toMatchObject({ taskId: null, operationId: null, unlinkedReason: "not_selected" });
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});

it("retains a lifecycle link when HTTP aborts before validated prepare completes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-late-binding-"));
  const config = loadConfig({ MCP_AUTH_TOKEN: "secret", MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: path.join(root,"state"), MCP_USAGE_LOG_DIR: path.join(root,"usage") }, root);
  config.port = 0; config.host = "127.0.0.1";
  const services = createServices(config), server = await startHttpServer(config, services);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const prepare = services.executionRecorder.prepare.bind(services.executionRecorder);
  const spy = vi.spyOn(services.executionRecorder, "prepare").mockImplementation(async input => { entered(); await gate; return prepare(input); });
  try {
    const task = await services.continuityService.create({ cwd: root, requestId: randomUUID(), objective: "test",
      checkpoint: { phase: "test", completed: [], current: "test", remaining: [], blockers: [], evidenceRefs: [], changedPaths: [] } });
    const controller = new AbortController(), operationId = randomUUID();
    const pending = fetch(`http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`, {
      method: "POST", signal: controller.signal,
      headers: { authorization: "Bearer secret", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "run_script", arguments: {
        taskId: task.taskId, operationId, runtime: "node", script: "process.exit(0)", yieldTimeMs: 3000,
      } } }),
    }).catch(() => null);
    await ready; controller.abort(); await pending;
    await new Promise(resolve => setTimeout(resolve, 50)); release();
    await vi.waitFor(async () => {
      expect((await services.continuityService.store.listExecutions(String(task.workspaceId), String(task.taskId))).some(e => e.operationId === operationId && e.state === "exited")).toBe(true);
    }, { timeout: 5000, interval: 50 });
    await services.usageLog.flush();
    const events = (await readFile(path.join(root,"usage","requests.jsonl"),"utf8")).trim().split("\n").map(s => JSON.parse(s));
    const request = events.find(e => e.event === "mcp_request");
    expect(request).toMatchObject({ outcome: "aborted", correlation: { taskId: null } });
    expect(events.find(e => e.event === "process_started")).toMatchObject({ requestId: request.requestId, correlation: { taskId: task.taskId, operationId } });
  } finally { release(); spy.mockRestore(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
