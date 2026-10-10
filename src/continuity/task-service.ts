import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { McpToolError } from "../errors.js";
import { summarizeContext } from "./context-summary.js";
import type { ExecutionRecorder } from "./execution-recorder.js";
import type { TaskStore } from "./task-store.js";
import type {
  EvidenceRef,
  ExecutionReconciliation,
  ExecutionRecord,
  MutationDedupeRecord,
  TaskRecord,
  WorkCheckpoint,
  WorkspaceIdentityRecord,
  WorkspaceState,
} from "./task-types.js";
import type { WorkspaceIdentityService } from "./workspace-identity.js";
import {
  compareWorkspace,
  observeWorkspace,
  type WorkspaceSnapshotLimits,
} from "./workspace-snapshot.js";

export type CheckpointInput = Omit<WorkCheckpoint, "executionReconciliations"> & {
  executionReconciliations?: Array<Omit<ExecutionReconciliation, "recordedAt">> | undefined;
};

export interface TaskContinuityOptions {
  checkpointMaxBytes: number;
  contextMaxBytes: number;
  candidateLimit: number;
  recentExecutionLimit: number;
  snapshotLimits: WorkspaceSnapshotLimits;
}

interface SelectedTask {
  state: WorkspaceState;
  task: TaskRecord;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function executionView(record: ExecutionRecord): Record<string, unknown> {
  return {
    operationId: record.operationId,
    taskId: record.taskId,
    workspaceId: record.workspaceId,
    bootId: record.bootId,
    sessionId: record.sessionId,
    state: record.state,
    toolKind: record.toolKind,
    preparedAt: record.preparedAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    outputBytes: record.outputBytes,
    persistenceState: record.persistenceState,
    errorCode: record.errorCode,
    callerResolution: record.callerResolution,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export class TaskContinuityService {
  constructor(
    readonly store: TaskStore,
    readonly workspaceIdentity: WorkspaceIdentityService,
    readonly executionRecorder: ExecutionRecorder,
    readonly options: TaskContinuityOptions,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  async health() {
    return this.store.health();
  }

  async create(input: {
    cwd: string;
    requestId: string;
    objective: string;
    checkpoint: CheckpointInput;
  }): Promise<Record<string, unknown>> {
    await this.initialize();
    this.validateCheckpoint(input.checkpoint);
    const identity = await this.workspaceIdentity.resolve(input.cwd);
    const inputHmac = await this.store.inputHmac({
      mode: "create",
      workspaceId: identity.workspaceId,
      objective: input.objective,
      checkpoint: input.checkpoint,
    });
    const normalizedCheckpoint = this.normalizeCheckpoint(input.checkpoint);
    const observation = await observeWorkspace(identity, this.options.snapshotLimits);

    return this.store.withWorkspaceLock(identity.workspaceId, async () => {
      const state = await this.store.readWorkspace(identity);
      const dedupe = this.checkDedupe(state, input.requestId, "create", inputHmac);
      if (dedupe) return clone(dedupe.result);
      if (state.activeTaskId) {
        const active = state.tasks[state.activeTaskId];
        throw new McpToolError(
          "active_task_conflict",
          `Workspace already has active task ${state.activeTaskId}`,
          active ? { taskId: active.taskId, revision: active.revision, objective: active.objective } : undefined,
        );
      }

      const now = new Date().toISOString();
      const taskId = randomUUID();
      const task: TaskRecord = {
        taskId,
        objective: input.objective,
        status: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        checkpoint: normalizedCheckpoint,
        lastObservedWorkspace: observation,
      };
      const result: Record<string, unknown> = {
        taskId,
        workspaceId: identity.workspaceId,
        revision: task.revision,
        workspaceRevision: state.workspaceRevision + 1,
        status: task.status,
      };
      state.workspace = identity;
      state.workspaceRevision += 1;
      state.activeTaskId = taskId;
      state.tasks[taskId] = task;
      state.mutationDedupe[input.requestId] = this.dedupeRecord(
        input.requestId,
        taskId,
        "create",
        inputHmac,
        result,
        now,
      );
      await this.store.writeWorkspace(state);
      return result;
    });
  }

  async update(input: {
    taskId: string;
    requestId: string;
    expectedRevision: number;
    checkpoint: CheckpointInput;
  }): Promise<Record<string, unknown>> {
    await this.initialize();
    this.validateCheckpoint(input.checkpoint);
    const selected = await this.requireTask(input.taskId);
    const identity = selected.state.workspace;
    const inputHmac = await this.store.inputHmac({
      mode: "update",
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      checkpoint: input.checkpoint,
    });
    const normalizedCheckpoint = this.normalizeCheckpoint(input.checkpoint);
    const observation = await observeWorkspace(identity, this.options.snapshotLimits);

    return this.store.withWorkspaceLock(identity.workspaceId, async () => {
      const state = await this.store.readWorkspace(identity);
      const dedupe = this.checkDedupe(state, input.requestId, "update", inputHmac);
      if (dedupe) return clone(dedupe.result);
      const task = this.requireActiveTask(state, input.taskId);
      if (task.revision !== input.expectedRevision) {
        throw new McpToolError(
          "revision_conflict",
          `Expected task revision ${input.expectedRevision}, current revision is ${task.revision}`,
          { taskId: task.taskId, currentRevision: task.revision },
        );
      }

      const now = new Date().toISOString();
      task.revision += 1;
      task.updatedAt = now;
      task.checkpoint = normalizedCheckpoint;
      task.lastObservedWorkspace = observation;
      state.workspaceRevision += 1;
      const result: Record<string, unknown> = {
        taskId: task.taskId,
        workspaceId: identity.workspaceId,
        revision: task.revision,
        workspaceRevision: state.workspaceRevision,
        status: task.status,
      };
      state.mutationDedupe[input.requestId] = this.dedupeRecord(
        input.requestId,
        task.taskId,
        "update",
        inputHmac,
        result,
        now,
      );
      await this.executionRecorder.withReconciliations(identity.workspaceId, task.taskId,
        normalizedCheckpoint.executionReconciliations ?? [], (records) => this.store.commitWorkspace(state, records));
      return result;
    });
  }

  async complete(input: {
    taskId: string;
    requestId: string;
    expectedRevision: number;
    outcome: "completed" | "abandoned";
    summary: string;
    evidenceRefs: EvidenceRef[];
  }): Promise<Record<string, unknown>> {
    await this.initialize();
    const selected = await this.requireTask(input.taskId);
    const identity = selected.state.workspace;
    const inputHmac = await this.store.inputHmac({
      mode: "complete",
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      outcome: input.outcome,
      summary: input.summary,
      evidenceRefs: input.evidenceRefs,
    });

    return this.store.withWorkspaceLock(identity.workspaceId, async () => {
      const state = await this.store.readWorkspace(identity);
      const dedupe = this.checkDedupe(state, input.requestId, "complete", inputHmac);
      if (dedupe) return clone(dedupe.result);
      const task = this.requireActiveTask(state, input.taskId);
      if (task.revision !== input.expectedRevision) {
        throw new McpToolError(
          "revision_conflict",
          `Expected task revision ${input.expectedRevision}, current revision is ${task.revision}`,
          { taskId: task.taskId, currentRevision: task.revision },
        );
      }

      const executions = await this.store.listExecutions(identity.workspaceId, task.taskId);
      const unresolved = executions.filter((record) => {
        if (record.state === "prepared" || record.state === "running") return true;
        if (record.state !== "unknown") return false;
        if (input.outcome === "abandoned") return false;
        return !record.callerResolution || record.callerResolution.resolution === "external_effect_unknown";
      });
      if (unresolved.length > 0) {
        throw new McpToolError(
          "unresolved_execution",
          `Task has ${unresolved.length} unresolved execution(s)`,
          { operationIds: unresolved.map((record) => record.operationId) },
        );
      }

      const now = new Date().toISOString();
      task.status = input.outcome;
      task.revision += 1;
      task.updatedAt = now;
      task.completedAt = now;
      task.summary = input.summary;
      task.checkpoint = {
        ...task.checkpoint,
        evidenceRefs: input.evidenceRefs,
      };
      state.workspaceRevision += 1;
      state.activeTaskId = null;
      const result: Record<string, unknown> = {
        taskId: task.taskId,
        workspaceId: identity.workspaceId,
        revision: task.revision,
        workspaceRevision: state.workspaceRevision,
        status: task.status,
        unresolvedUnknown: input.outcome === "abandoned"
          ? executions.filter((record) => record.state === "unknown").map((record) => record.operationId)
          : [],
      };
      state.mutationDedupe[input.requestId] = this.dedupeRecord(
        input.requestId,
        task.taskId,
        "complete",
        inputHmac,
        result,
        now,
      );
      await this.store.writeWorkspace(state);
      return result;
    });
  }

  async context(input: {
    cwd?: string | undefined;
    taskId?: string | undefined;
    recentExecutionLimit?: number | undefined;
    candidateLimit?: number | undefined;
    format?: "summary" | "full" | undefined;
  }): Promise<Record<string, unknown>> {
    const context = await this.readContext(input, input.format === "summary");
    return input.format === "summary" ? summarizeContext(context, this.options.contextMaxBytes) : context;
  }

  private async readContext(input: {
    cwd?: string | undefined;
    taskId?: string | undefined;
    recentExecutionLimit?: number | undefined;
    candidateLimit?: number | undefined;
  }, compact = false): Promise<Record<string, unknown>> {
    await this.initialize();
    let selected: SelectedTask | null = null;
    let candidateResult:
      | Awaited<ReturnType<TaskStore["activeCandidates"]>>
      | undefined;

    if (input.taskId) {
      selected = await this.requireTask(input.taskId);
      if (input.cwd) {
        const requestedIdentity = await this.workspaceIdentity.resolve(input.cwd);
        if (requestedIdentity.workspaceId !== selected.state.workspace.workspaceId) {
          throw new McpToolError("workspace_mismatch", "taskId and cwd resolve to different workspaces");
        }
      }
    } else if (input.cwd) {
      const identity = await this.workspaceIdentity.resolve(input.cwd);
      const state = await this.store.readWorkspace(identity);
      if (state.activeTaskId) {
        const task = state.tasks[state.activeTaskId];
        if (task) selected = { state, task };
      }
      if (!selected) {
        return {
          selection: "none",
          workspace: identity,
          task: null,
          observation: await observeWorkspace(identity, this.options.snapshotLimits),
          executions: { running: [], unsettled: [], recent: [] },
          evidence: "unchecked",
          drift: "unknown",
          driftReasons: ["no_active_task"],
          resume: "state_unavailable",
          truncation: { omittedCounts: {}, nextCursor: null, perSectionErrors: [] },
        };
      }
    } else {
      candidateResult = await this.store.activeCandidates(
        Math.max(1, Math.min(input.candidateLimit ?? this.options.candidateLimit, 100)),
      );
      if (candidateResult.candidates.length === 1 && candidateResult.complete) {
        selected = await this.requireTask(candidateResult.candidates[0]!.taskId);
      } else {
        return {
          selection: candidateResult.candidates.length === 0 && candidateResult.complete
            ? "none"
            : "selection_required",
          candidates: candidateResult.candidates,
          candidateSearchComplete: candidateResult.complete,
          task: null,
          executions: { running: [], unsettled: [], recent: [] },
          evidence: "unchecked",
          drift: "unknown",
          driftReasons: candidateResult.complete ? ["no_unique_active_task"] : ["candidate_search_truncated"],
          resume: candidateResult.candidates.length === 0 && candidateResult.complete
            ? "state_unavailable"
            : "selection_required",
          truncation: {
            omittedCounts: candidateResult.complete ? {} : { candidates: 1 },
            nextCursor: null,
            perSectionErrors: [],
          },
        };
      }
    }

    const { state, task } = selected!;
    const current = await observeWorkspace(state.workspace, this.options.snapshotLimits);
    const comparison = compareWorkspace(task.lastObservedWorkspace, current);
    const allExecutions = await this.store.listExecutions(state.workspace.workspaceId, task.taskId);
    const recentLimit = Math.max(
      1,
      Math.min(input.recentExecutionLimit ?? this.options.recentExecutionLimit, 50),
    );
    const running = allExecutions.filter((record) => record.state === "running").map(executionView);
    const unsettled = allExecutions
      .filter((record) => record.state === "prepared" || record.state === "running" || record.state === "unknown")
      .map(executionView);
    let recent = allExecutions
      .filter((record) => record.state === "exited" || record.state === "spawn_failed")
      .slice(0, recentLimit)
      .map(executionView);
    const evidence = await this.verifyEvidence(state.workspace, task.checkpoint.evidenceRefs, allExecutions, comparison.evidence);

    const response: Record<string, unknown> = {
      selection: "selected",
      workspace: state.workspace,
      task: {
        taskId: task.taskId,
        objective: task.objective,
        status: task.status,
        revision: task.revision,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        completedAt: task.completedAt,
        summary: task.summary,
        checkpoint: task.checkpoint,
        lastObservedWorkspace: task.lastObservedWorkspace,
        legacy: task.legacy,
      },
      observation: current,
      drift: comparison.drift,
      driftReasons: comparison.reasons,
      executions: {
        running,
        unsettled,
        recent,
        total: allExecutions.length,
      },
      evidence,
      resume: "context_available",
      truncation: {
        omittedCounts: {
          recentExecutions: Math.max(
            0,
            allExecutions.filter((record) => record.state === "exited" || record.state === "spawn_failed").length - recent.length,
          ),
        },
        nextCursor: null,
        perSectionErrors: [],
      },
    };

    // Do not discard recent receipts to make room for file fingerprints that
    // the compact view will omit anyway.
    if (compact) return response;
    while (Buffer.byteLength(JSON.stringify(response)) > this.options.contextMaxBytes && recent.length > 0) {
      recent = recent.slice(0, -1);
      (response.executions as Record<string, unknown>).recent = recent;
      ((response.truncation as Record<string, unknown>).omittedCounts as Record<string, number>).recentExecutions =
        allExecutions.filter((record) => record.state === "exited" || record.state === "spawn_failed").length - recent.length;
    }
    if (Buffer.byteLength(JSON.stringify(response)) > this.options.contextMaxBytes) {
      const taskView = response.task as Record<string, unknown>;
      const checkpoint = clone(task.checkpoint);
      checkpoint.completed = checkpoint.completed.slice(-20);
      checkpoint.remaining = checkpoint.remaining.slice(0, 20);
      checkpoint.changedPaths = checkpoint.changedPaths.slice(0, 50);
      checkpoint.evidenceRefs = checkpoint.evidenceRefs.slice(0, 20);
      checkpoint.blockers = checkpoint.blockers.slice(0, 20);
      taskView.checkpoint = checkpoint;
      ((response.truncation as Record<string, unknown>).omittedCounts as Record<string, number>).checkpoint = 1;
    }
    return response;
  }

  private async verifyEvidence(
    identity: WorkspaceIdentityRecord,
    refs: EvidenceRef[],
    executions: ExecutionRecord[],
    fallback: "present" | "changed" | "unchecked",
  ): Promise<"present" | "missing" | "changed" | "unchecked"> {
    if (refs.length === 0) return fallback;
    let unchecked = false;
    const executionIds = new Set(executions.map((record) => record.operationId));
    for (const ref of refs.slice(0, 50)) {
      if (ref.kind === "receipt") {
        if (!ref.operationId || !executionIds.has(ref.operationId)) return "missing";
        continue;
      }
      if (!ref.path || !ref.sha256) {
        unchecked = true;
        continue;
      }
      const absolute = path.resolve(identity.executionRoot, ref.path);
      if (!isWithin(identity.executionRoot, absolute)) return "missing";
      try {
        const info = await stat(absolute);
        if (!info.isFile() || info.size > 16 * 1024 * 1024) {
          unchecked = true;
          continue;
        }
        const digest = createHash("sha256").update(await readFile(absolute)).digest("hex");
        if (digest !== ref.sha256) return "changed";
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        unchecked = true;
      }
    }
    return unchecked ? "unchecked" : "present";
  }

  private validateCheckpoint(checkpoint: CheckpointInput): void {
    const bytes = Buffer.byteLength(JSON.stringify(checkpoint));
    if (bytes > this.options.checkpointMaxBytes) {
      throw new McpToolError(
        "storage_full",
        `Checkpoint is ${bytes} bytes; maximum is ${this.options.checkpointMaxBytes}`,
      );
    }
  }

  private normalizeCheckpoint(checkpoint: CheckpointInput): WorkCheckpoint {
    const recordedAt = new Date().toISOString();
    return {
      phase: checkpoint.phase,
      completed: [...checkpoint.completed],
      current: checkpoint.current,
      remaining: [...checkpoint.remaining],
      changedPaths: [...checkpoint.changedPaths],
      evidenceRefs: checkpoint.evidenceRefs.map((ref) => ({ ...ref })),
      blockers: [...checkpoint.blockers],
      ...(checkpoint.executionReconciliations
        ? {
            executionReconciliations: checkpoint.executionReconciliations.map((item) => ({
              ...item,
              evidenceRefs: item.evidenceRefs.map((ref) => ({ ...ref })),
              recordedAt,
            })),
          }
        : {}),
    };
  }

  private async requireTask(taskId: string): Promise<SelectedTask> {
    const found = await this.store.findTask(taskId);
    if (!found) throw new McpToolError("unknown_task", `Unknown task: ${taskId}`);
    const task = found.state.tasks[taskId];
    if (!task) throw new McpToolError("state_corrupt", `Task index is inconsistent: ${taskId}`);
    return { state: found.state, task };
  }

  private requireActiveTask(state: WorkspaceState, taskId: string): TaskRecord {
    const task = state.tasks[taskId];
    if (!task) throw new McpToolError("unknown_task", `Unknown task: ${taskId}`);
    if (task.status !== "active" || state.activeTaskId !== taskId) {
      throw new McpToolError("task_closed", `Task is not active: ${taskId}`);
    }
    return task;
  }

  private checkDedupe(
    state: WorkspaceState,
    requestId: string,
    kind: MutationDedupeRecord["kind"],
    inputHmac: string,
  ): MutationDedupeRecord | null {
    const existing = state.mutationDedupe[requestId];
    if (!existing) return null;
    if (existing.kind === kind && existing.inputHmac === inputHmac) return existing;
    throw new McpToolError(
      "idempotency_conflict",
      `requestId ${requestId} was already used with different mutation input`,
    );
  }

  private dedupeRecord(
    requestId: string,
    taskId: string,
    kind: MutationDedupeRecord["kind"],
    inputHmac: string,
    result: Record<string, unknown>,
    recordedAt: string,
  ): MutationDedupeRecord {
    return { requestId, taskId, kind, inputHmac, result: clone(result), recordedAt };
  }
}
