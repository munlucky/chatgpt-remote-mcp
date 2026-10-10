import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "../config.js";
import { runTool } from "../tool-result.js";
import {
  createCachedToolRegistrar,
  TOOL_ANNOTATIONS,
  toolAuthMetadata,
  type CachedToolRegistrar,
} from "../tool-metadata.js";
import type { TaskContinuityService } from "./task-service.js";

const evidenceRefSchema = z.object({
  kind: z.enum(["receipt", "artifact"]).describe("Evidence type: a durable execution receipt or a workspace artifact."),
  operationId: z.string().uuid().optional().describe("Tracked execution operation ID when the evidence is an execution receipt."),
  path: z.string().max(4096).optional().describe("Workspace-relative artifact path when the evidence is a file."),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Expected SHA-256 for an artifact."),
  workspaceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Workspace fingerprint observed when this evidence was verified."),
});

const reconciliationSchema = z.object({
  operationId: z.string().uuid().describe("Unknown tracked execution being reconciled."),
  resolution: z
    .enum(["verified_no_retry", "external_effect_unknown", "superseded"])
    .describe("Caller judgment. This does not rewrite the server-observed execution outcome."),
  evidenceRefs: z.array(evidenceRefSchema).max(50).default([]).describe("Current artifact or receipt evidence supporting the reconciliation."),
  note: z.string().max(2048).optional().describe("Short structured explanation; do not include secrets, prompts, command bodies, or code dumps."),
});

const checkpointSchema = z.object({
  phase: z.string().min(1).max(128).describe("Short current phase name chosen by ChatGPT."),
  completed: z.array(z.string().max(2048)).max(100).default([]).describe("Bounded summaries of completed work."),
  current: z.string().max(4096).describe("What ChatGPT is currently trying to accomplish."),
  remaining: z.array(z.string().max(2048)).max(100).default([]).describe("Bounded summaries of remaining work."),
  changedPaths: z.array(z.string().max(4096)).max(500).default([]).describe("Paths ChatGPT believes were changed; current workspace observation remains authoritative."),
  evidenceRefs: z.array(evidenceRefSchema).max(100).default([]).describe("Receipts or artifacts supporting the checkpoint claims."),
  blockers: z.array(z.string().max(2048)).max(100).default([]).describe("Blockers that may require later inspection or user input."),
  executionReconciliations: z
    .array(reconciliationSchema)
    .max(50)
    .optional()
    .describe("Explicit caller reconciliation for unknown executions after current-state inspection."),
});

const checkpointInputSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create").describe("Create a new active task. Read-only context lookup never creates tasks."),
    cwd: z.string().min(1).describe("Workspace path in the MCP execution environment, such as /shared/project."),
    requestId: z.string().uuid().describe("Idempotency key reused only when retrying this exact mutation."),
    objective: z.string().min(1).max(8192).describe("Bounded task objective. Do not store the original prompt or secrets."),
    checkpoint: checkpointSchema.describe("Initial bounded checkpoint."),
  }),
  z.object({
    mode: z.literal("update").describe("Replace the latest checkpoint for an existing active task."),
    taskId: z.string().uuid().describe("Existing active continuity task ID."),
    requestId: z.string().uuid().describe("Idempotency key reused only when retrying this exact mutation."),
    expectedRevision: z.number().int().min(1).describe("Current task revision. Stale revisions fail instead of auto-merging."),
    checkpoint: checkpointSchema.describe("Replacement bounded checkpoint."),
  }),
]);

export function registerTaskTools(
  server: McpServer,
  config: AppConfig,
  service: TaskContinuityService,
  onlyTool?: string,
): void {
  const authMetadata = toolAuthMetadata(config);

  if (!onlyTool || onlyTool === "get_work_context") server.registerTool(
    "get_work_context",
    {
      title: "Get durable work context",
      description:
        "Call before starting or resuming project work. Read durable task checkpoints and execution receipts, then compare them with current workspace state. The default summary is compact; use format=full for checkpoint details and file fingerprints. This read-only tool never creates/resumes a task or authorizes execution. Without taskId/cwd it selects only one complete active candidate; otherwise choose explicitly.",
      inputSchema: {
        cwd: z.string().min(1).optional().describe("Workspace path in the MCP execution environment. Used to select that workspace's active task."),
        taskId: z.string().uuid().optional().describe("Specific continuity task ID. When cwd is also supplied both must resolve to the same workspace."),
        format: z.enum(["summary", "full"]).default("summary").describe("Compact recovery summary by default. full returns bounded checkpoint details, file fingerprints and execution receipts. Summary omissions are explicit; they never authorize retries or completion."),
        recentExecutionLimit: z.number().int().min(1).max(50).default(10).describe("Maximum recent terminal execution receipts returned. Unsettled executions are returned independently."),
        candidateLimit: z.number().int().min(1).max(100).default(20).describe("Maximum active workspace candidates returned when neither cwd nor taskId is supplied."),
        cursor: z.string().max(128).optional().describe("Reserved bounded-list cursor. Current v1 responses return nextCursor=null when no further page is available."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ cwd, taskId, recentExecutionLimit, candidateLimit, format }) =>
      runTool(async () => ({
        ...await service.context({ cwd, taskId, recentExecutionLimit, candidateLimit, format }),
        executionTracking: config.executionTracking,
      })),
  );

  if (!onlyTool || onlyTool === "checkpoint_work") server.registerTool(
    "checkpoint_work",
    {
      title: "Create or update durable work checkpoint",
      description:
        "Persist ChatGPT's bounded task intent/checkpoint with explicit create or update semantics. create fails when the workspace already has an active task. update requires expectedRevision and never auto-merges conflicts. Reusing the same requestId with identical input returns the original result; different input fails.",
      inputSchema: checkpointInputSchema,
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async (input) => runTool(() =>
      input.mode === "create"
        ? service.create(input)
        : service.update(input),
    ),
  );

  if (!onlyTool || onlyTool === "complete_work") server.registerTool(
    "complete_work",
    {
      title: "Complete or abandon durable work",
      description:
        "Record a terminal task outcome and atomically clear the workspace active pointer. completed is rejected while tracked executions remain running, prepared, or unresolved unknown. abandoned records an explicit stop but never terminates OS processes implicitly.",
      inputSchema: {
        taskId: z.string().uuid().describe("Existing active continuity task ID."),
        requestId: z.string().uuid().describe("Idempotency key reused only when retrying this exact terminal mutation."),
        expectedRevision: z.number().int().min(1).describe("Current task revision. Stale revisions fail instead of auto-merging."),
        outcome: z.enum(["completed", "abandoned"]).describe("Terminal outcome explicitly chosen by ChatGPT."),
        summary: z.string().max(8192).describe("Bounded completion or abandonment summary; do not store prompts, command bodies, or secrets."),
        evidenceRefs: z.array(evidenceRefSchema).max(100).default([]).describe("Receipts or artifact hashes supporting the terminal decision."),
      },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed,
      _meta: authMetadata,
    },
    async (input) => runTool(() => service.complete(input)),
  );
}

export function createTaskToolRegistrar(
  config: AppConfig,
  service: TaskContinuityService,
): CachedToolRegistrar {
  return createCachedToolRegistrar((collector) => registerTaskTools(collector, config, service));
}
