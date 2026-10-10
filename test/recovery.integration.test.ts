import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices, type McpServices } from "../src/mcp-server.js";

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const data = (result: ToolResult) => result.structuredContent as Record<string, any>;
const header = (result: ToolResult) => JSON.parse((result.content as Array<{ text: string }>)[0]!.text.split("\n")[0]!);

describe.sequential("GPT work recovery over stateless HTTP", () => {
  let root: string;
  let services: McpServices;
  let running: RunningHttpServer;
  let endpoint: URL;
  const clients: Client[] = [];

  async function connect(): Promise<Client> {
    const client = new Client({ name: "recovery-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { authorization: "Bearer recovery-test" } },
    }));
    return client;
  }

  async function createTask(client: Client): Promise<string> {
    const result = await client.callTool({ name: "checkpoint_work", arguments: {
      mode: "create", cwd: root, requestId: randomUUID(), objective: "finish the original task once",
      checkpoint: { phase: "execution", current: "run verification", completed: [], remaining: ["review results", "complete"], changedPaths: [], evidenceRefs: [], blockers: [] },
    } });
    expect(result.isError).not.toBe(true);
    return String(data(result).taskId);
  }

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mcp-recovery-"));
    const config = loadConfig({
      MCP_AUTH_TOKEN: "recovery-test", MCP_HOST: "127.0.0.1", MCP_DEFAULT_CWD: root,
      MCP_CONTINUITY_STATE_DIR: path.join(root, "state"), MCP_EXECUTION_TRACKING: "required",
    }, root);
    config.port = 0;
    services = createServices(config);
    running = await startHttpServer(config, services);
    endpoint = new URL(`http://127.0.0.1:${(running.httpServer.address() as AddressInfo).port}/mcp`);
  });

  afterEach(async () => {
    await Promise.allSettled(clients.splice(0).map((client) => client.close()));
    await running?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("rejects untracked shell and script calls before spawn and supplies a read-only recovery call", async () => {
    const client = await connect();
    for (const [name, args] of [
      ["exec_command", { cmd: "touch must-not-exist" }],
      ["run_script", { runtime: "node", script: "throw new Error('must not execute')" }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(data(result)).toMatchObject({ code: "tracking_required", details: {
        nextCall: { tool: "get_work_context", arguments: { cwd: root } },
      } });
    }
    expect(services.processManager.list()).toHaveLength(0);
    const context = await client.callTool({ name: "get_work_context", arguments: { cwd: root } });
    expect(data(context)).toMatchObject({ format: "summary", task: null, executionTracking: "required", recovery: { automaticRetryAllowed: false } });
    expect((await services.continuityService.store.activeCandidates(20)).candidates).toHaveLength(0);
    expect(client.getInstructions()?.slice(0, 512)).toContain("get_work_context");
    expect(client.getInstructions()?.slice(0, 512)).toContain("Tracking policy: required");
  });

  it("keeps a tracked worker after its HTTP reply is lost and recovers without running it twice", async () => {
    const terminalWrites = vi.spyOn(services.executionRecorder, "markTerminal");
    const firstClient = await connect();
    const taskId = await createTask(firstClient);
    const operationId = randomUUID();
    const args = {
      taskId, operationId, runtime: "node", workdir: root, yieldTimeMs: 30_000,
      script: "import { appendFileSync } from 'node:fs'; appendFileSync('counter.txt', 'once\\n'); console.log('started'); await new Promise(r => setTimeout(r, 2500)); console.log('finished');",
    };
    const controller = new AbortController();
    const lostReply = fetch(endpoint, {
      method: "POST", signal: controller.signal,
      headers: { authorization: "Bearer recovery-test", "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "run_script", arguments: args } }),
    }).then(() => "received", (error: Error) => error.name);
    const deadline = Date.now() + 2000;
    while (services.processManager.list().length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(services.processManager.list()).toHaveLength(1);
    controller.abort();
    expect(await lostReply).toBe("AbortError");
    await firstClient.close();

    const resumed = await connect();
    const context = await resumed.callTool({ name: "get_work_context", arguments: { taskId } });
    // The reply can be lost between spawn and the atomic running-receipt write.
    // A prepared reservation is uncertainty, not proof that no worker exists.
    expect(data(context)).toMatchObject({ task: { taskId, status: "active" }, executions: { counts: { unsettled: 1 } } });
    expect(data(context).executions.unsettled[0]).toMatchObject({ operationId, state: expect.stringMatching(/^(prepared|running)$/) });
    const status = await resumed.callTool({ name: "list_processes", arguments: { taskId, runningOnly: true } });
    expect(data(status)).toMatchObject({ counts: { matching: 1, running: 1, returned: 1 }, truncated: false });
    expect(data(status).processes[0]).toMatchObject({ taskId, operationId, running: true });
    expect(data(status).processes[0]).not.toHaveProperty("command");
    expect(data(status).processes[0]).not.toHaveProperty("output");

    const replay = await resumed.callTool({ name: "run_script", arguments: args });
    expect(data(replay)).toMatchObject({ taskId, operationId, duplicate: true, executionState: expect.stringMatching(/^(prepared|running)$/) });
    expect(header(replay)).toMatchObject({ taskId, operationId, duplicate: true });
    expect(services.processManager.list()).toHaveLength(1);
    const sessionId = String(data(status).processes[0].sessionId);
    await services.processManager.waitForExit(sessionId, 4000);
    expect(await Promise.allSettled(terminalWrites.mock.results.map((entry) => entry.value))).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
    ]);
    const completed = await resumed.callTool({ name: "read_process", arguments: { sessionId, afterSeq: 0, maxOutputBytes: 16 * 1024 } });
    expect(data(completed)).toMatchObject({ taskId, operationId, completed: true, executionState: "exited", persistenceState: "ok", exitCode: 0, nextCall: { tool: "get_work_context", arguments: { taskId } } });
    expect(header(completed)).toMatchObject({ taskId, operationId, executionState: "exited" });
    expect(await readFile(path.join(root, "counter.txt"), "utf8")).toBe("once\n");
    expect(data(await resumed.callTool({ name: "get_work_context", arguments: { taskId } })).task.status).toBe("active");
    const terminalReplay = await resumed.callTool({ name: "run_script", arguments: args });
    expect(header(terminalReplay)).toMatchObject({ taskId, operationId, duplicate: true, executionState: "exited" });
    expect(data(terminalReplay).stdout).toBe("started\nfinished\n");
    expect(await readFile(path.join(root, "counter.txt"), "utf8")).toBe("once\n");
  });

  it("drains completed output with explicit cursors and returns bounded task-filtered metadata", async () => {
    const client = await connect();
    const taskId = await createTask(client);
    const first = await client.callTool({ name: "run_script", arguments: {
      taskId, operationId: randomUUID(), runtime: "node", workdir: root, yieldTimeMs: 3000,
      maxOutputBytes: 16 * 1024, script: "process.stdout.write('x'.repeat(40 * 1024))",
    } });
    expect(first.isError).not.toBe(true);
    expect(data(first)).toMatchObject({ completed: true, hasMore: true });
    let result = first;
    let output = String(data(first).stdout);
    while (data(result).hasMore) {
      const call = data(result).nextCall;
      expect(call.arguments.afterSeq).toBe(data(result).nextSeq);
      result = await client.callTool({ name: call.tool, arguments: call.arguments });
      expect(data(result)).toMatchObject({ taskId, executionState: "exited" });
      output += String(data(result).stdout);
    }
    expect(output).toBe("x".repeat(40 * 1024));
    await client.callTool({ name: "run_script", arguments: {
      taskId, operationId: randomUUID(), runtime: "node", workdir: root, yieldTimeMs: 3000, script: "console.log('second')",
    } });
    const listing = data(await client.callTool({ name: "list_processes", arguments: { taskId, limit: 1 } }));
    expect(listing).toMatchObject({ counts: { matching: 2, running: 0, returned: 1 }, truncated: true });
    expect(listing.processes).toHaveLength(1);
    expect(listing.processes[0]).not.toHaveProperty("command");
    expect(data(await client.callTool({ name: "list_processes", arguments: { taskId: randomUUID() } })).processes).toEqual([]);
    const verbose = data(await client.callTool({ name: "list_processes", arguments: { cwd: root, includeCommand: true } }));
    expect(verbose.processes[0].command).toEqual(expect.any(String));
    const full = data(await client.callTool({ name: "get_work_context", arguments: { taskId, format: "full" } }));
    expect(full.task.checkpoint.remaining).toEqual(["review results", "complete"]);
    expect(full.observation).toHaveProperty("files");
  });
});
