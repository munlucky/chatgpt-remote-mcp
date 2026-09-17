import { McpToolError } from "../errors.js";
import type { WorkspaceIdentityService } from "./workspace-identity.js";
import type { ExecutionRecord } from "./task-types.js";
import { CONTINUITY_SCHEMA_VERSION } from "./task-types.js";
import type { TaskStore } from "./task-store.js";

export interface ExecutionPreparation {
  record: ExecutionRecord;
  shouldSpawn: boolean;
}

export interface ExecutionTerminalObservation {
  sessionId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnFailed?: boolean | undefined;
  totalOutputBytes: number;
  errorCode?: string | null;
}

export class ExecutionRecorder {
  constructor(
    readonly store: TaskStore,
    readonly workspaceIdentity: WorkspaceIdentityService,
  ) {}

  async prepare(input: {
    taskId: string;
    operationId: string;
    cwd: string;
    toolKind: "exec_command" | "run_script";
    semanticInput: unknown;
  }): Promise<ExecutionPreparation> {
    await this.store.initialize();
    const identity = await this.workspaceIdentity.resolve(input.cwd);
    const inputHmac = await this.store.inputHmac({
      toolKind: input.toolKind,
      semanticInput: input.semanticInput,
    });

    return this.store.withWorkspaceLock(identity.workspaceId, async () => {
      const state = await this.store.readWorkspace(identity);
      const task = state.tasks[input.taskId];
      if (!task) throw new McpToolError("unknown_task", `Unknown task: ${input.taskId}`);
      if (task.status !== "active" || state.activeTaskId !== input.taskId) {
        throw new McpToolError("task_closed", `Task is not active: ${input.taskId}`);
      }
      return this.store.withExecutionLock(input.operationId, async () => {
        const existing = await this.store.readExecution(identity.workspaceId, input.operationId);
        if (existing) {
          if (
            existing.taskId !== input.taskId ||
            existing.workspaceId !== identity.workspaceId ||
            existing.toolKind !== input.toolKind ||
            existing.inputHmac !== inputHmac
          ) {
            throw new McpToolError(
              "idempotency_conflict",
              `operationId ${input.operationId} was already used for a different execution`,
            );
          }
          return { record: existing, shouldSpawn: false };
        }

        const record: ExecutionRecord = {
          schemaVersion: CONTINUITY_SCHEMA_VERSION,
          operationId: input.operationId,
          taskId: input.taskId,
          workspaceId: identity.workspaceId,
          bootId: this.store.bootId,
          sessionId: null,
          state: "prepared",
          toolKind: input.toolKind,
          inputHmac,
          preparedAt: new Date().toISOString(),
          startedAt: null,
          endedAt: null,
          exitCode: null,
          signal: null,
          timedOut: null,
          outputBytes: null,
          persistenceState: "ok",
          errorCode: null,
        };
        await this.store.writeExecution(record);
        return { record, shouldSpawn: true };
      });
    });
  }

  async markRunning(record: ExecutionRecord, sessionId: string): Promise<ExecutionRecord> {
    return this.store.withExecutionLock(record.operationId, async () => {
      const current = await this.require(record.workspaceId, record.operationId);
      if (current.state === "running" && current.sessionId === sessionId) return current;
      if (current.state !== "prepared") return current;
      const updated: ExecutionRecord = {
        ...current,
        sessionId,
        state: "running",
        startedAt: new Date().toISOString(),
      };
      await this.store.writeExecution(updated);
      return updated;
    });
  }

  async markSpawnFailed(record: ExecutionRecord, errorCode = "spawn_failed"): Promise<ExecutionRecord> {
    return this.store.withExecutionLock(record.operationId, async () => {
      const current = await this.require(record.workspaceId, record.operationId);
      if (current.state !== "prepared") return current;
      const updated: ExecutionRecord = {
        ...current,
        state: "spawn_failed",
        endedAt: new Date().toISOString(),
        errorCode,
      };
      await this.store.writeExecution(updated);
      return updated;
    });
  }

  async markTerminal(
    workspaceId: string,
    operationId: string,
    observation: ExecutionTerminalObservation,
  ): Promise<ExecutionRecord> {
    return this.store.withExecutionLock(operationId, async () => {
      const current = await this.require(workspaceId, operationId);
      if (current.state === "exited" || current.state === "spawn_failed") return current;
      if (current.state === "unknown" && current.bootId !== this.store.bootId) return current;
      const updated: ExecutionRecord = {
        ...current,
        sessionId: observation.sessionId,
        state: observation.spawnFailed ? "spawn_failed" : "exited",
        startedAt: current.startedAt ?? current.preparedAt,
        endedAt: new Date().toISOString(),
        exitCode: observation.exitCode,
        signal: observation.signal,
        timedOut: observation.timedOut,
        outputBytes: observation.totalOutputBytes,
        errorCode: observation.errorCode ?? current.errorCode,
      };
      await this.store.writeExecution(updated);
      return updated;
    });
  }

  async markPersistenceDegraded(
    workspaceId: string,
    operationId: string,
  ): Promise<void> {
    await this.store.withExecutionLock(operationId, async () => {
      const current = await this.store.readExecution(workspaceId, operationId);
      if (!current) return;
      try {
        await this.store.writeExecution({ ...current, persistenceState: "degraded" });
      } catch {
        // The original persistence failure is authoritative; never re-run the command to repair it.
      }
    });
  }

  async reconcile(
    workspaceId: string,
    taskId: string,
    reconciliation: NonNullable<ExecutionRecord["callerResolution"]>,
  ): Promise<void> {
    await this.store.withExecutionLock(reconciliation.operationId, async () => {
      const current = await this.require(workspaceId, reconciliation.operationId);
      if (current.taskId !== taskId) {
        throw new McpToolError("workspace_mismatch", "Execution does not belong to the selected task");
      }
      if (current.state !== "unknown") {
        throw new McpToolError(
          "idempotency_conflict",
          `Execution ${reconciliation.operationId} is ${current.state}, not unknown`,
        );
      }
      if (current.callerResolution) {
        const sameResolution =
          current.callerResolution.resolution === reconciliation.resolution &&
          current.callerResolution.note === reconciliation.note &&
          JSON.stringify(current.callerResolution.evidenceRefs) === JSON.stringify(reconciliation.evidenceRefs);
        if (sameResolution) return;
        throw new McpToolError(
          "idempotency_conflict",
          `Execution ${reconciliation.operationId} already has a different caller resolution`,
        );
      }
      await this.store.writeExecution({ ...current, callerResolution: reconciliation });
    });
  }

  private async require(workspaceId: string, operationId: string): Promise<ExecutionRecord> {
    const current = await this.store.readExecution(workspaceId, operationId);
    if (!current) {
      throw new McpToolError("state_corrupt", `Missing execution record: ${operationId}`);
    }
    return current;
  }
}
