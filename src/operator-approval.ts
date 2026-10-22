import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { tokensEqual } from "./auth.js";
import type { AppConfig } from "./config.js";
import type { TaskContinuityService } from "./continuity/task-service.js";
import { McpToolError } from "./errors.js";
import { identityBinding, IDENTITY_WORKER_SOURCE, kernelDigest } from "./kernel-identity-worker.js";
import { OperatorApprovalStore, type ApprovalRecord } from "./operator-approval-store.js";
import type { ProcessManager, ProcessTerminalEvent } from "./process-manager.js";

export interface ApprovalInput {
  taskId: string; requestId: string; cwd: string;
  operation: "kernel_identity_adopt"; sourceProjectId: string; legacyProjectId: string; reason: string;
}

interface ApprovalExecutionBinding {
  kernelCwd: string;
  workspaceId: string;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const expired = (record: ApprovalRecord) => Date.parse(record.expiresAt) <= Date.now();

export class OperatorApprovalService {
  readonly store: OperatorApprovalStore;

  constructor(readonly config: AppConfig, private readonly continuity: TaskContinuityService,
    private readonly processes: ProcessManager) {
    this.store = new OperatorApprovalStore(path.join(config.continuityStateDir, "operator-approvals"), config.operatorApprovalKey ?? "disabled");
  }

  async initialize(): Promise<void> {
    if (this.config.operatorApprovalEnabled) await this.store.initialize();
  }

  async close(): Promise<void> {
    if (this.config.operatorApprovalEnabled) await this.store.close();
  }

  async hasUnresolvedExecution(taskId: string): Promise<boolean> {
    if (!this.config.operatorApprovalEnabled) return false;
    return this.store.read(records => records.some(r => r.taskId === taskId && ["executing", "unknown"].includes(r.status)));
  }

  async executionContext(taskId: string): Promise<Record<string, unknown>[]> {
    return this.store.read(records => records.filter(r => r.taskId === taskId && ["executing", "unknown"].includes(r.status))
      .slice(0, 20).map(r => ({ approvalRequestId: r.id, status: r.status, operationId: r.operationId, sessionId: r.sessionId,
        nextCall: { tool: "get_operator_approval", arguments: { approvalRequestId: r.id } } })));
  }

  private owner(principal: string | undefined): string {
    if (!this.config.operatorApprovalEnabled) throw new McpToolError("approval_disabled", "Operator approval bridge is disabled");
    if (!principal) throw new McpToolError("approval_auth_required", "An authenticated transport identity is required");
    return hash(principal);
  }

  private find(records: ApprovalRecord[], id: string, owner?: string): ApprovalRecord {
    const record = records.find(item => item.id === id && (owner === undefined || item.owner === owner));
    if (!record) throw new McpToolError("approval_not_found", "Approval request not found");
    return record;
  }

  private async activeTask(taskId: string, cwd: string, workspaceId?: string): Promise<string> {
    const selected = await this.continuity.store.findTask(taskId);
    const identity = await this.continuity.workspaceIdentity.resolve(cwd);
    if (!selected || selected.state.activeTaskId !== taskId || selected.state.tasks[taskId]?.status !== "active"
      || identity.workspaceId !== selected.state.workspace.workspaceId || (workspaceId && identity.workspaceId !== workspaceId)) {
      throw new McpToolError("approval_task_mismatch", "Approval requires the same active continuity task and workspace");
    }
    return identity.workspaceId;
  }

  private async bindExecutionTarget(input: ApprovalInput): Promise<ApprovalExecutionBinding> {
    // Continuity aliases identify the task. They must not select the Kernel identity.
    // realpath resolves filesystem links, but preserves distinct bind-mount paths.
    const kernelCwd = await realpath(path.resolve(this.config.defaultCwd, input.cwd));
    const workspaceId = await this.activeTask(input.taskId, kernelCwd);
    return { kernelCwd, workspaceId };
  }

  async request(input: ApprovalInput, principal?: string): Promise<Record<string, unknown>> {
    const owner = this.owner(principal);
    const inputDigest = hash(JSON.stringify(input));
    const duplicate = await this.store.read(records => records.find(r => r.owner === owner && r.requestId === input.requestId));
    if (duplicate) {
      if (duplicate.inputDigest !== inputDigest) throw new McpToolError("idempotency_conflict", "requestId was used for different approval input");
      return this.view(duplicate);
    }
    const { kernelCwd, workspaceId } = await this.bindExecutionTarget(input);
    const kernelHome = await realpath(this.config.kernelHome);
    const kernelCli = path.join(kernelHome, ".moon-relay/kernel-payload/bin/moon-relay-kernel.mjs");
    const digest = await kernelDigest(kernelCli);
    const { stdout } = await promisify(execFile)(process.execPath, [kernelCli, "identity", "status", "--json"], {
      cwd: kernelCwd, env: { ...process.env, MOON_RELAY_KERNEL_HOME: kernelHome, MCP_OPERATOR_APPROVAL_KEY: "" },
      encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024, windowsHide: true,
    });
    const status = JSON.parse(stdout) as Record<string, unknown>;
    const normalizedRoot = kernelCwd.replaceAll("\\", "/").replace(/\/+$/, "");
    if (status.projectId !== input.sourceProjectId || status.canonicalRoot !== (process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot)
      || status.runtimeHome !== kernelHome) {
      throw new McpToolError("approval_identity_mismatch", "Kernel identity does not match the requested workspace, runtime, or source project");
    }
    let identityDigest: string;
    try { identityDigest = hash(identityBinding(status, input.legacyProjectId)); }
    catch { throw new McpToolError("approval_identity_ineligible", "Kernel did not report an eligible legacy identity adoption"); }
    const record = await this.store.mutate(records => {
      const raced = records.find(r => r.owner === owner && r.requestId === input.requestId);
      if (raced) {
        if (raced.inputDigest !== inputDigest) throw new McpToolError("idempotency_conflict", "requestId conflict");
        return raced;
      }
      if (records.length >= 1000) throw new McpToolError("storage_full", "Approval ledger reached its 1000-record limit");
      const record: ApprovalRecord = {
        ...input, cwd: kernelCwd, workspaceId, owner, inputDigest, kernelHome, kernelCli, kernelDigest: digest, identityDigest,
        id: randomUUID(), viewToken: randomBytes(32).toString("hex"), status: "pending",
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + this.config.operatorApprovalTtlSeconds * 1000).toISOString(),
      };
      records.push(record);
      return record;
    });
    return this.view(record);
  }

  async get(id: string, principal?: string): Promise<Record<string, unknown>> {
    const owner = this.owner(principal);
    return this.store.read(records => this.view(this.find(records, id, owner)));
  }

  async browserRecord(id: string, viewToken: string): Promise<ApprovalRecord> {
    if (!this.config.operatorApprovalEnabled) throw new McpToolError("approval_disabled", "Approval bridge disabled");
    return this.store.read(records => {
      const record = this.find(records, id);
      if (!tokensEqual(record.viewToken, viewToken)) throw new McpToolError("approval_not_found", "Approval request not found");
      return record;
    });
  }

  async decide(id: string, viewToken: string, decision: "approve" | "deny"): Promise<void> {
    await this.browserRecord(id, viewToken);
    await this.store.mutate(records => {
      const record = this.find(records, id);
      const next = decision === "approve" ? "approved" : "denied";
      if (record.status === next) return;
      if (record.status !== "pending" || expired(record)) throw new McpToolError("approval_not_pending", "Approval is expired or already decided");
      record.status = next;
      record.decidedBy = "operator-key-holder";
      if (next === "approved") {
        record.approvalRef = `moonremote:approval:${randomUUID()}`;
        record.approvedAt = new Date().toISOString();
      }
    });
  }

  async execute(id: string, operationId: string, principal?: string): Promise<Record<string, unknown>> {
    const owner = this.owner(principal);
    const existing = await this.store.read(records => this.find(records, id, owner));
    return this.continuity.store.withWorkspaceLock(existing.workspaceId, () => this.executeLocked(id, operationId, principal));
  }

  private async executeLocked(id: string, operationId: string, principal?: string): Promise<Record<string, unknown>> {
    const owner = this.owner(principal);
    const existing = await this.store.read(records => this.find(records, id, owner));
    if (existing.operationId) {
      if (existing.operationId !== operationId) throw new McpToolError("approval_already_consumed", "Approval is bound to another execution; inspect its result");
      return this.view(existing);
    }
    await this.activeTask(existing.taskId, existing.cwd, existing.workspaceId);
    const reserved = await this.store.mutate(records => {
      const record = this.find(records, id, owner);
      if (record.operationId) {
        if (record.operationId !== operationId) throw new McpToolError("approval_already_consumed", "Approval already consumed");
        return { record, start: false };
      }
      if (record.status !== "approved" || expired(record) || !record.approvalRef) {
        throw new McpToolError("approval_required", "A current operator approval is required");
      }
      if (records.some(r => r.id !== id && (r.workspaceId === record.workspaceId || r.cwd === record.cwd)
        && ["executing", "unknown"].includes(r.status))) {
        throw new McpToolError("approval_unresolved_execution", "Inspect the earlier identity execution before starting another");
      }
      if (records.some(r => r.operationId === operationId)) throw new McpToolError("idempotency_conflict", "operationId was used for another approval");
      record.status = "executing";
      record.operationId = operationId;
      return { record, start: true };
    });
    if (!reserved.start) return this.view(reserved.record);
    const record = reserved.record;
    try {
      const sessionId = this.processes.start({
        executable: process.execPath, args: ["--input-type=module", "-e", IDENTITY_WORKER_SOURCE, JSON.stringify({
          cwd: record.cwd, kernelHome: record.kernelHome, kernelCli: record.kernelCli, kernelDigest: record.kernelDigest,
          sourceProjectId: record.sourceProjectId, legacyProjectId: record.legacyProjectId,
          identityDigest: record.identityDigest, approvalRef: record.approvalRef,
        })],
        cwd: record.cwd, commandForDisplay: `Kernel identity adoption approval=${record.id}`,
        env: { MCP_OPERATOR_APPROVAL_KEY: "" }, timeoutMs: 70000,
        tracking: { taskId: record.taskId, operationId, workspaceId: record.workspaceId },
        onTerminal: event => this.finish(record.id, event),
      });
      await this.store.mutate(records => { this.find(records, id).sessionId = sessionId; });
    } catch {
      await this.store.mutate(records => {
        const item = this.find(records, id);
        item.status = "unknown";
        item.result = { code: "execution_start_uncertain", nextAction: "Inspect existing processes and Kernel receipts before any retry" };
      });
    }
    return this.get(id, principal);
  }

  private async finish(id: string, event: ProcessTerminalEvent): Promise<void> {
    let result: Record<string, unknown> = { code: "execution_not_verified" };
    let succeeded = false;
    try {
      const output = await this.processes.read(event.sessionId, { maxOutputBytes: 16384 });
      const parsed = JSON.parse(output.stdout) as Record<string, unknown>;
      if (!output.hasMore && output.droppedOutputBytes === 0) result = parsed;
      succeeded = event.exitCode === 0 && !event.timedOut && !event.spawnFailed && result.status === "succeeded";
    } catch { /* Missing or truncated output is uncertainty, never success. */ }
    await this.store.mutate(records => {
      const record = this.find(records, id);
      record.status = succeeded ? "succeeded" : "unknown";
      record.finishedAt = event.endedAt;
      record.sessionId = event.sessionId;
      record.result = result;
    });
  }

  private view(record: ApprovalRecord): Record<string, unknown> {
    const status = ["pending", "approved"].includes(record.status) && expired(record) ? "expired" : record.status;
    return {
      approvalRequestId: record.id, taskId: record.taskId, operation: record.operation,
      cwd: record.cwd, sourceProjectId: record.sourceProjectId, legacyProjectId: record.legacyProjectId,
      reason: record.reason, status, createdAt: record.createdAt, expiresAt: record.expiresAt,
      ...(status === "pending" ? { approvalUrl: `${this.config.publicUrl}/operator-approvals/${record.id}?token=${record.viewToken}` } : {}),
      approvalRef: record.approvalRef, approvedAt: record.approvedAt, decidedBy: record.decidedBy,
      operationId: record.operationId, sessionId: record.sessionId, result: record.result,
      ...(status === "pending" ? { nextAction: "wait_for_human_operator_at_approval_url" }
        : status === "approved" ? { nextCall: { tool: "execute_approved_operation", arguments: { approvalRequestId: record.id }, required: ["operationId"] } }
        : status === "executing" ? { nextCall: { tool: "get_operator_approval", arguments: { approvalRequestId: record.id } }, pollAfterMs: 1000 }
        : ["succeeded", "unknown"].includes(status) ? { nextCall: { tool: "get_work_context", arguments: { taskId: record.taskId } },
          nextAction: status === "unknown" ? "inspect_kernel_identity_and_receipts_without_retry" : "continue_existing_kernel_workflow" }
        : { nextAction: "stop_denied_or_expired_request" }),
      boundary: "Application approval workflow; unrestricted root tools are not isolated by this bridge",
    };
  }
}
