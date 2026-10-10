export const CONTINUITY_SCHEMA_VERSION = 2 as const;
export const INSTALLATION_SCHEMA_VERSION = 1 as const;

export type TaskStatus = "active" | "completed" | "abandoned";
export type ExecutionState = "prepared" | "running" | "exited" | "spawn_failed" | "unknown";

export interface EvidenceRef {
  kind: "receipt" | "artifact";
  operationId?: string | undefined;
  path?: string | undefined;
  sha256?: string | undefined;
  workspaceFingerprint?: string | undefined;
}

export interface ExecutionReconciliation {
  operationId: string;
  resolution: "verified_no_retry" | "external_effect_unknown" | "superseded";
  evidenceRefs: EvidenceRef[];
  note?: string | undefined;
  recordedAt: string;
}

export interface WorkCheckpoint {
  phase: string;
  completed: string[];
  current: string;
  remaining: string[];
  changedPaths: string[];
  evidenceRefs: EvidenceRef[];
  blockers: string[];
  executionReconciliations?: ExecutionReconciliation[] | undefined;
}

export interface WorkspaceIdentityRecord {
  workspaceId: string;
  executionRoot: string;
  gitRoot: string | null;
  gitCommonDir: string | null;
  worktreeIdentity: string;
  repository: boolean;
}

export interface FileFingerprint {
  path: string;
  status: string;
  size: number | null;
  mode: string | null;
  symlinkTarget: string | null;
  sha256: string | null;
  indexObjectId: string | null;
}

export interface WorkspaceObservation {
  observedAt: string;
  completedAt: string;
  repository: boolean;
  head: string | null;
  unborn: boolean;
  branch: string | null;
  detached: boolean;
  worktreeIdentity: string;
  statusDigest: string;
  fingerprint: string;
  files: FileFingerprint[];
  completeness: "complete" | "partial" | "unknown";
  reasons: string[];
  inspectedFiles: number;
  inspectedBytes: number;
  maxFiles: number;
  maxBytes: number;
  maxDurationMs: number;
}

export interface TaskRecord {
  taskId: string;
  objective: string;
  status: TaskStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  summary?: string | undefined;
  checkpoint: WorkCheckpoint;
  lastObservedWorkspace: WorkspaceObservation;
  legacy?: {
    fromSchemaVersion: 1;
    checkpointClaims: "caller_claim";
    completionClaim: "caller_claim" | null;
  };
}

export interface MutationDedupeRecord {
  requestId: string;
  taskId: string;
  kind: "create" | "update" | "complete";
  inputHmac: string;
  result: Record<string, unknown>;
  recordedAt: string;
}

export interface WorkspaceState {
  schemaVersion: typeof CONTINUITY_SCHEMA_VERSION;
  workspace: WorkspaceIdentityRecord;
  workspaceRevision: number;
  activeTaskId: string | null;
  tasks: Record<string, TaskRecord>;
  mutationDedupe: Record<string, MutationDedupeRecord>;
}

export interface ExecutionRecord {
  schemaVersion: typeof CONTINUITY_SCHEMA_VERSION;
  operationId: string;
  taskId: string;
  workspaceId: string;
  bootId: string;
  sessionId: string | null;
  state: ExecutionState;
  toolKind: "exec_command" | "run_script";
  inputHmac: string;
  preparedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean | null;
  outputBytes: number | null;
  persistenceState: "ok" | "degraded";
  errorCode: string | null;
  callerResolution?: ExecutionReconciliation | undefined;
}

export interface ContinuityHealth {
  schemaVersion: number;
  stateDirectory: string;
  initialized: boolean;
  writerGuardHeld: boolean;
  pendingWrites: number;
  failedWrites: number;
  unknownExecutions: number;
  bytesUsed: number;
}
