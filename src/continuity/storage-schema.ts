import * as z from "zod/v4";

import { McpToolError } from "../errors.js";
import type { ExecutionRecord, WorkspaceState } from "./task-types.js";

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const workspaceId = z.string().regex(/^[a-f0-9]{32}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = count.min(1);
const timestamp = z.iso.datetime();
const text = z.string().max(8192);
const evidence = z.strictObject({
  kind: z.enum(["receipt", "artifact"]),
  operationId: uuid.optional(), path: text.optional(), sha256: digest.optional(),
  workspaceFingerprint: digest.optional(),
});
const reconciliation = z.strictObject({
  operationId: uuid,
  resolution: z.enum(["verified_no_retry", "external_effect_unknown", "superseded"]),
  evidenceRefs: z.array(evidence).max(50), note: text.optional(), recordedAt: timestamp,
});
const checkpoint = z.strictObject({
  phase: text.min(1), completed: z.array(text).max(100), current: text,
  remaining: z.array(text).max(100), changedPaths: z.array(text).max(500),
  evidenceRefs: z.array(evidence).max(100), blockers: z.array(text).max(100),
  executionReconciliations: z.array(reconciliation).max(50).optional(),
});
const observation = z.strictObject({
  observedAt: timestamp, completedAt: timestamp, repository: z.boolean(),
  head: text.nullable(), unborn: z.boolean(), branch: text.nullable(), detached: z.boolean(),
  worktreeIdentity: text.min(1), statusDigest: digest, fingerprint: digest,
  files: z.array(z.strictObject({
    path: text, status: text, size: count.nullable(), mode: text.nullable(),
    symlinkTarget: text.nullable(), sha256: digest.nullable(), indexObjectId: text.nullable(),
  })),
  completeness: z.enum(["complete", "partial", "unknown"]), reasons: z.array(text),
  inspectedFiles: count, inspectedBytes: count, maxFiles: count, maxBytes: count, maxDurationMs: count,
});
const task = z.strictObject({
  taskId: uuid, objective: text.min(1), status: z.enum(["active", "completed", "abandoned"]),
  revision, createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp.optional(),
  summary: text.optional(), checkpoint, lastObservedWorkspace: observation,
  legacy: z.strictObject({
    fromSchemaVersion: z.literal(1), checkpointClaims: z.literal("caller_claim"),
    completionClaim: z.literal("caller_claim").nullable(),
  }).optional(),
});
const result = z.strictObject({
  taskId: uuid, workspaceId, revision, workspaceRevision: revision,
  status: z.enum(["active", "completed", "abandoned"]), unresolvedUnknown: z.array(uuid).optional(),
});
const workspaceShape = {
  workspace: z.strictObject({
    workspaceId, executionRoot: text.min(1), gitRoot: text.nullable(), gitCommonDir: text.nullable(),
    worktreeIdentity: text.min(1), repository: z.boolean(),
  }),
  workspaceRevision: count, activeTaskId: uuid.nullable(), tasks: z.record(uuid, task),
  mutationDedupe: z.record(uuid, z.strictObject({
    requestId: uuid, taskId: uuid, kind: z.enum(["create", "update", "complete"]),
    inputHmac: digest, result, recordedAt: timestamp,
  })),
};
const executionShape = {
  operationId: uuid, taskId: uuid, workspaceId, bootId: uuid, sessionId: text.nullable(),
  state: z.enum(["prepared", "running", "exited", "spawn_failed", "unknown"]),
  toolKind: z.enum(["exec_command", "run_script"]), inputHmac: digest,
  preparedAt: timestamp, startedAt: timestamp.nullable(), endedAt: timestamp.nullable(),
  exitCode: z.number().int().nullable(), signal: z.string().regex(/^SIG[A-Z0-9]+$/).nullable(),
  timedOut: z.boolean().nullable(), outputBytes: count.nullable(),
  persistenceState: z.enum(["ok", "degraded"]), errorCode: text.nullable(),
  callerResolution: reconciliation.optional(),
};

function corrupt(file: string): never {
  // Do not include untrusted record values or validation issues in errors.
  throw new McpToolError("state_corrupt", `Invalid continuity record: ${file}`);
}

function decode(raw: string, file: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return corrupt(file); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return corrupt(file);
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 && record.schemaVersion !== 2) {
    throw new McpToolError("unsupported_schema", `Unsupported continuity schema in ${file}`);
  }
  return record;
}

export function parseWorkspace(raw: string, file: string): WorkspaceState {
  const value = decode(raw, file);
  const parsed = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), ...workspaceShape }).safeParse(value);
  if (!parsed.success) return corrupt(file);
  const state = parsed.data;
  const active = Object.values(state.tasks).filter((entry) => entry.status === "active");
  if (active.length > 1 || (state.activeTaskId === null ? active.length !== 0 : active[0]?.taskId !== state.activeTaskId)) return corrupt(file);
  for (const [id, entry] of Object.entries(state.tasks)) {
    if (id !== entry.taskId || entry.revision > state.workspaceRevision) return corrupt(file);
    if ((entry.status === "active") === (entry.completedAt !== undefined)) return corrupt(file);
    if (entry.lastObservedWorkspace.worktreeIdentity !== state.workspace.worktreeIdentity) return corrupt(file);
  }
  for (const [id, entry] of Object.entries(state.mutationDedupe)) {
    const owner = state.tasks[entry.taskId];
    if (id !== entry.requestId || !owner || entry.result.taskId !== entry.taskId
      || entry.result.workspaceId !== state.workspace.workspaceId
      || entry.result.revision > owner.revision || entry.result.workspaceRevision > state.workspaceRevision
      || (entry.kind === "complete" ? entry.result.status === "active" : entry.result.status !== "active")) return corrupt(file);
  }
  if (state.schemaVersion === 1) {
    for (const entry of Object.values(state.tasks)) {
      if (entry.legacy) return corrupt(file);
      entry.legacy = { fromSchemaVersion: 1, checkpointClaims: "caller_claim", completionClaim: entry.status === "active" ? null : "caller_claim" };
    }
  }
  return { ...state, schemaVersion: 2 };
}

export function parseExecution(raw: string, file: string): ExecutionRecord {
  const value = decode(raw, file);
  const parsed = z.strictObject({ schemaVersion: z.union([z.literal(1), z.literal(2)]), ...executionShape }).safeParse(value);
  if (!parsed.success) return corrupt(file);
  const record = parsed.data;
  if (record.callerResolution && (record.state !== "unknown" || record.callerResolution.operationId !== record.operationId)) return corrupt(file);
  if (record.state === "prepared" && (record.sessionId !== null || record.startedAt !== null || record.endedAt !== null)) return corrupt(file);
  if (record.state === "running" && (!record.sessionId || !record.startedAt || record.endedAt !== null)) return corrupt(file);
  if ((record.state === "exited" || record.state === "spawn_failed") && !record.endedAt) return corrupt(file);
  return { ...record, schemaVersion: 2 } as ExecutionRecord;
}

export function validateOwnership(state: WorkspaceState, records: ExecutionRecord[], file: string): void {
  const byId = new Map(records.map((record) => [record.operationId, record]));
  for (const record of records) {
    if (record.workspaceId !== state.workspace.workspaceId || !Object.hasOwn(state.tasks, record.taskId)) return corrupt(file);
    for (const ref of record.callerResolution?.evidenceRefs ?? []) {
      const referenced = ref.operationId ? byId.get(ref.operationId) : undefined;
      if (ref.kind === "receipt" && referenced && referenced.taskId !== record.taskId) return corrupt(file);
    }
  }
  for (const owner of Object.values(state.tasks)) {
    for (const entry of owner.checkpoint.executionReconciliations ?? []) {
      const record = byId.get(entry.operationId);
      if (!record || record.taskId !== owner.taskId) return corrupt(file);
    }
    const refs = [
      ...owner.checkpoint.evidenceRefs,
      ...(owner.checkpoint.executionReconciliations ?? []).flatMap((entry) => entry.evidenceRefs),
    ];
    for (const ref of refs) {
      const record = ref.operationId ? byId.get(ref.operationId) : undefined;
      if (ref.kind === "receipt" && record && record.taskId !== owner.taskId) return corrupt(file);
    }
  }
}
