import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { parseExecution, parseWorkspace } from "../src/continuity/storage-schema.js";

it("joins before filtering and distinguishes retries, drain, legacy, conflict and missing evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "usage-integrity-"));
  const workspaceId = "a".repeat(32), otherWorkspace = "b".repeat(32), taskId = randomUUID(), operationId = randomUUID(), bootId = randomUUID(), sessionId = randomUUID();
  const correlation = { workspaceId, taskId, operationId, sessionId, executionBootId: bootId, unlinkedReason: null };
  const start = { event: "process_started", schemaVersion: 2, timestamp: "2026-10-09T01:00:00Z", startedAt: "2026-10-09T01:00:00Z", buildId: "build-a", bootId, sessionId, correlation, requestId: randomUUID() };
  const terminal = { ...start, event: "process_terminal", timestamp: "2026-10-09T02:00:00Z", endedAt: "2026-10-09T01:00:01Z", exitCode: 0, signal: null, timedOut: false, spawnFailed: false, totalOutputBytes: 10 };
  const request = { ...start, requestId: randomUUID(), event: "mcp_request", timestamp: "2026-10-09T01:00:02Z", toolName: "read_process", durationMs: 1, toolError: false, status: 200, responseBytes: 100,
    processRead: { running: false, hasMore: false, outputBytes: 10, droppedOutputBytes: 0 } };
  const stateDir = path.join(root,"state"), workspaceDir = path.join(stateDir,"workspaces",workspaceId);
  const receipt = { schemaVersion: 2, workspaceId, operationId, taskId, bootId, sessionId, state: "exited", toolKind: "run_script", inputHmac: "c".repeat(64), preparedAt: start.timestamp,
    startedAt: start.timestamp, endedAt: terminal.endedAt, exitCode: 0, signal: null, timedOut: false, outputBytes: 10, persistenceState: "ok", errorCode: null };
  const run = (extra: string[] = []) => JSON.parse(execFileSync(process.execPath, ["scripts/usage-report.mjs", root,
    "--since", "2026-10-09T00:00:00Z", "--until", "2026-10-09T01:30:00Z", "--receipts-dir", stateDir, ...extra], { encoding: "utf8" }));
  try {
    await mkdir(path.join(workspaceDir,"executions"), { recursive: true });
    const observation = { observedAt: start.timestamp, completedAt: start.timestamp, repository: false, head: null, unborn: false,
      branch: null, detached: false, worktreeIdentity: "synthetic", statusDigest: "d".repeat(64), fingerprint: "e".repeat(64), files: [],
      completeness: "complete", reasons: [], inspectedFiles: 0, inspectedBytes: 0, maxFiles: 10, maxBytes: 1024, maxDurationMs: 1000 };
    const state = { schemaVersion: 2, workspace: { workspaceId, executionRoot: "synthetic", gitRoot: null, gitCommonDir: null, worktreeIdentity: "synthetic", repository: false },
      workspaceRevision: 1, activeTaskId: taskId, mutationDedupe: {}, tasks: { [taskId]: { taskId, objective: "test", status: "active", revision: 1, createdAt: start.timestamp, updatedAt: start.timestamp,
        checkpoint: { phase: "test", completed: [], current: "test", remaining: [], changedPaths: [], evidenceRefs: [], blockers: [] }, lastObservedWorkspace: observation } } };
    expect(() => parseWorkspace(JSON.stringify(state), "fixture")).not.toThrow();
    expect(() => parseExecution(JSON.stringify(receipt), "fixture")).not.toThrow();
    await writeFile(path.join(workspaceDir,"state.json"), JSON.stringify(state));
    const dedupeId = randomUUID(), absentTask = randomUUID();
    const invalidDedupe = { ...state, mutationDedupe: { [dedupeId]: { requestId: dedupeId, taskId: absentTask, kind: "create", inputHmac: "c".repeat(64), recordedAt: start.timestamp,
      result: { taskId: absentTask, workspaceId, revision: 1, workspaceRevision: 1, status: "active" } } } };
    expect(() => parseWorkspace(JSON.stringify(invalidDedupe), "fixture")).toThrow();
    const receiptPath = path.join(workspaceDir,"executions",`${operationId}.json`);
    await writeFile(receiptPath, JSON.stringify(receipt));
    const conflictId = randomUUID();
    const conflictCorrelation = { ...correlation, sessionId: conflictId, operationId: randomUUID() };
    const events = [start, start, terminal, request, { ...request, requestId: randomUUID(), processRead: { ...request.processRead, running: true, outputBytes: 0 } },
      { ...request, requestId: randomUUID(), toolName: "run_script" },
      { ...start, requestId: randomUUID(), sessionId: randomUUID(), correlation: { ...correlation, workspaceId: otherWorkspace } },
      { ...start, requestId: randomUUID(), sessionId: conflictId, correlation: conflictCorrelation },
      { ...terminal, timestamp: start.timestamp, sessionId: conflictId, correlation: conflictCorrelation, exitCode: 1 },
      { ...terminal, timestamp: start.timestamp, sessionId: conflictId, correlation: conflictCorrelation, exitCode: 2 },
      { event: "process_started", timestamp: start.timestamp, bootId: "old", sessionId: "old" },
      { ...request, requestId: start.requestId, correlation: { taskId: null }, outcome: "aborted" }];
    await writeFile(path.join(root,"requests.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
    const report = run(["--task-id",taskId,"--workspace-id",workspaceId,"--build-id","build-a"]);
    expect(report.counts).toMatchObject({ httpRequests: 4, logicalExecutions: 2, processExecutions: 2 });
    expect(report.integrity.find((e: any) => e.sessionId === sessionId)).toMatchObject({ state: "terminal_outside_window", receipt: "matched", duplicateEvents: 1 });
    expect(report.integrity.find((e: any) => e.sessionId === conflictId)).toMatchObject({ state: "event_conflict" });
    expect(report.polling.perExecution.find((e: any) => e.sessionId === sessionId)).toMatchObject({ emptyRunning: 1, terminalOutputReads: 2 });
    expect(report.correlationSources.derivedFromLifecycle).toBe(1);
    expect(report.diagnostics.boots[0]).toMatchObject({ status: "unknown", droppedEvents: null });
    expect(report.output.deliveredProcessBytes).toBe(30);
    const unfiltered = run();
    expect(unfiltered.integrity.some((e: any) => e.state === "legacy_or_untracked")).toBe(true);
    // The same operation ID in a different workspace is a separate logical execution.
    expect(unfiltered.counts.repeatedOperationExecutions).toBe(0);
    expect(await readFile(receiptPath,"utf8")).toBe(JSON.stringify(receipt));
    await writeFile(receiptPath, JSON.stringify({ ...receipt, state: "prepared", sessionId: null, startedAt: null, endedAt: null }));
    expect(run().integrity.find((e: any) => e.sessionId === sessionId).receipt).toBe("uncertain_or_degraded");
    await writeFile(receiptPath, JSON.stringify({ ...receipt, startedAt: "not-a-timestamp" }));
    expect(run().integrity.find((e: any) => e.sessionId === sessionId).receipt).toBe("schema_unknown");
    await writeFile(receiptPath, JSON.stringify(receipt));
    await writeFile(path.join(workspaceDir,"state.json"), JSON.stringify({ ...state, tasks: { [taskId]: {} } }));
    expect(run().integrity.find((e: any) => e.sessionId === sessionId).receipt).toBe("owner_unknown");
    await writeFile(path.join(workspaceDir,"state.json"), JSON.stringify(state));
    await writeFile(path.join(workspaceDir,"state.json"), JSON.stringify(invalidDedupe));
    expect(run().integrity.find((e: any) => e.sessionId === sessionId).receipt).toBe("owner_unknown");
    const invalidLegacy = { ...state, schemaVersion: 1, tasks: { [taskId]: { ...state.tasks[taskId], legacy: { fromSchemaVersion: 1, checkpointClaims: "caller_claim", completionClaim: null } } } };
    expect(() => parseWorkspace(JSON.stringify(invalidLegacy), "fixture")).toThrow();
    await writeFile(path.join(workspaceDir,"state.json"), JSON.stringify(invalidLegacy));
    expect(run().integrity.find((e: any) => e.sessionId === sessionId).receipt).toBe("owner_unknown");
    await writeFile(path.join(workspaceDir,"state.json"), JSON.stringify(state));
    await writeFile(path.join(root,"requests.jsonl.1"), JSON.stringify({ ...start, timestamp: "2026-10-08T01:00:00Z", sessionId: randomUUID(), buildId: "older-build" }));
    expect(run(["--build-id","build-a"]).counts.repeatedOperationExecutions).toBe(1);
    await mkdir(path.join(workspaceDir,"transactions"));
    await writeFile(path.join(workspaceDir,"transactions","pending.json"), "{}");
    expect(run().integrity.find((e: any) => e.sessionId === sessionId).receipt).toBe("pending_journal_inconclusive");
  } finally { await rm(root, { recursive: true, force: true }); }
});
