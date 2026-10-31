import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { requestMetrics, type RequestMetrics } from "../src/telemetry.js";

function metrics(): RequestMetrics {
  return { setupMs: null, toolMs: null, toolError: null };
}

it("keeps normal receipt writes bounded as execution history grows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-receipt-growth-"));
  const services = createServices(loadConfig({
    MCP_AUTH_TOKEN: "test",
    MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: path.join(root, "state"),
  }, root));
  try {
    const task = await services.continuityService.create({
      cwd: root, requestId: randomUUID(), objective: "bounded receipt writes",
      checkpoint: { phase: "test", current: "measure", completed: [], remaining: [], changedPaths: [], evidenceRefs: [], blockers: [] },
    });
    const prepare = (operationId: string) => services.executionRecorder.prepare({
      cwd: root, taskId: String(task.taskId), operationId,
      toolKind: "run_script" as const, semanticInput: { operationId },
    });
    // Exceed the previous full-scan threshold with a realistic history.
    for (let i = 0; i < 180; i += 1) {
      await prepare(randomUUID());
    }
    const operationId = randomUUID();
    const writeMetrics = metrics();
    const fresh = await requestMetrics.run(writeMetrics, () => prepare(operationId));
    expect(fresh.shouldSpawn).toBe(true);
    expect(writeMetrics.continuity?.receiptReads ?? 0).toBeLessThanOrEqual(3);
    expect(writeMetrics.continuity?.syncCalls ?? 0).toBeLessThanOrEqual(8);

    const transitionMetrics = metrics();
    await requestMetrics.run(transitionMetrics, () => services.executionRecorder.markRunning(fresh.record, "session-1"));
    expect(transitionMetrics.continuity?.receiptReads ?? 0).toBeLessThanOrEqual(3);
    expect(transitionMetrics.continuity?.syncCalls ?? 0).toBeLessThanOrEqual(8);

    const replay = await prepare(operationId);
    expect(replay.shouldSpawn).toBe(false);
    expect(replay.record.sessionId).toBe("session-1");

    const recordFile = path.join(root, "state", "workspaces", fresh.record.workspaceId, "executions", operationId + ".json");
    expect(JSON.parse(await readFile(recordFile, "utf8")).state).toBe("running");

    // Explicit invalidation and recovery intentionally revisit the originals.
    await services.continuityService.store.invalidateWorkspace(fresh.record.workspaceId);
    const revalidateMetrics = metrics();
    expect(await requestMetrics.run(revalidateMetrics,
      () => services.continuityService.store.readExecution(fresh.record.workspaceId, operationId)))
      .toMatchObject({ state: "running", taskId: task.taskId });
    expect(revalidateMetrics.continuity?.receiptReads ?? 0).toBeGreaterThanOrEqual(180);
  } finally {
    await services.processManager.shutdown();
    await services.continuityService.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reuses successful durability checks and invalidates them when a file changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-durable-proof-"));
  const services = createServices(loadConfig({
    MCP_AUTH_TOKEN: "test", MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: path.join(root, "state"),
  }, root));
  try {
    const task = await services.continuityService.create({
      cwd: root, requestId: randomUUID(), objective: "durability proofs",
      checkpoint: { phase: "test", current: "verify", completed: [], remaining: [], changedPaths: [], evidenceRefs: [], blockers: [] },
    });
    const prepared = (await services.executionRecorder.prepare({
      cwd: root, taskId: String(task.taskId), operationId: randomUUID(),
      toolKind: "run_script", semanticInput: {},
    })).record;
    const once = metrics(), again = metrics();
    await requestMetrics.run(once, () => services.continuityService.store.readExecution(prepared.workspaceId, prepared.operationId));
    await requestMetrics.run(again, () => services.continuityService.store.readExecution(prepared.workspaceId, prepared.operationId));
    expect(once.continuity?.syncCalls ?? 0).toBe(0);
    expect(again.continuity?.syncCalls ?? 0).toBe(0);

    await services.continuityService.store.invalidateWorkspace(prepared.workspaceId);
    const afterInvalidation = metrics(), second = metrics();
    await requestMetrics.run(afterInvalidation, () => services.continuityService.store.readExecution(prepared.workspaceId, prepared.operationId));
    await requestMetrics.run(second, () => services.continuityService.store.readExecution(prepared.workspaceId, prepared.operationId));
    expect(afterInvalidation.continuity?.syncCalls ?? 0).toBeGreaterThan(0);
    expect(second.continuity?.syncCalls ?? 0).toBe(0);
  } finally {
    await services.processManager.shutdown();
    await services.continuityService.close();
    await rm(root, { recursive: true, force: true });
  }
});
