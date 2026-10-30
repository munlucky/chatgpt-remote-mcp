import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { ExecutionRecorder } from "./continuity/execution-recorder.js";
import { McpToolError } from "./errors.js";
import type { ProcessManager } from "./process-manager.js";
import type { ReviewPlan } from "./kernel-review-runtime.js";

export class KernelReviewService {
  constructor(private config: AppConfig, private processes: ProcessManager, private recorder: ExecutionRecorder) {}

  private async plan(cwd: string, mode: ReviewPlan["mode"], taskId?: string, runId?: string): Promise<ReviewPlan> {
    if (!this.config.kernelReview.enabled) throw new McpToolError("invalid_input", "Set MCP_KERNEL_REVIEW_ENABLED=true to enable independent reviews");
    return { mode, cwd: await realpath(path.resolve(this.config.defaultCwd, cwd)), runId,
      parentSessionId: `moonremote:${taskId || "capability-check"}`, kernelHome: this.config.kernelHome,
      target: this.config.kernelReview.target, codexExecutable: this.config.kernelReview.codexExecutable,
      timeoutMs: mode === "status" ? 15000 : this.config.kernelReview.timeoutMs, hostExecutor: this.config.hostExecutor };
  }
  private worker() {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(moduleDir, moduleDir.endsWith(path.sep + "dist" + path.sep + "src") ? "../../scripts/kernel-review-worker.mjs" : "../scripts/kernel-review-worker.mjs");
  }
  async status(cwd: string, probeModelTools = false): Promise<Record<string, unknown>> {
    if (!this.config.kernelReview.enabled) return { status: "disabled", reason: "MCP_KERNEL_REVIEW_ENABLED=false", canExecuteReview: false };
    const plan = await this.plan(cwd, "status");
    plan.probeModelTools = probeModelTools;
    if (probeModelTools) plan.timeoutMs = 45000;
    try {
      const { stdout } = await promisify(execFile)(process.execPath, [this.worker(), JSON.stringify(plan)], {
        cwd: plan.cwd, timeout: plan.timeoutMs + 10000, maxBuffer: 256 * 1024, env: { ...process.env, MCP_OPERATOR_APPROVAL_KEY: "" }, windowsHide: true });
      return JSON.parse(stdout);
    } catch (error) {
      let detail: Record<string, unknown> = {};
      try {
        const output = (error as { stdout?: string }).stdout;
        if (output && Buffer.byteLength(output) < 16384) detail = JSON.parse(output);
      } catch { /* Malformed worker output never establishes availability. */ }
      return { ...detail, status: "blocked", canExecuteReview: false, reason: detail.reason ?? "review_preflight_failed",
        nextAction: "Check Kernel payload, Codex sign-in, native companion, path mapping, and built worker before changing project files" };
    }
  }
  async start(input: { cwd: string; runId: string; taskId: string; operationId: string }): Promise<Record<string, unknown>> {
    const plan = await this.plan(input.cwd, "review", input.taskId, input.runId);
    const preparation = await this.recorder.prepare({ taskId: input.taskId, operationId: input.operationId,
      cwd: plan.cwd, toolKind: "run_script", semanticInput: { action: "kernel-independent-review", cwd: plan.cwd, runId: input.runId } });
    const record = preparation.record;
    if (!preparation.shouldSpawn) return { duplicate: true, taskId: input.taskId, operationId: input.operationId,
      sessionId: record.sessionId, executionState: record.state,
      nextCall: record.sessionId && record.bootId === this.recorder.store.bootId
        ? { tool: "read_process", arguments: { sessionId: record.sessionId, taskId: input.taskId, operationId: input.operationId, waitMode: "terminal", waitMs: 30000 } }
        : { tool: "get_work_context", arguments: { taskId: input.taskId } } };
    let sessionId: string;
    try {
      sessionId = this.processes.start({ executable: process.execPath, args: [this.worker(), JSON.stringify(plan)], cwd: plan.cwd,
        env: { MCP_OPERATOR_APPROVAL_KEY: "" }, timeoutMs: plan.timeoutMs + 15000,
        commandForDisplay: `Kernel independent review ${input.runId}`,
        tracking: { taskId: input.taskId, operationId: input.operationId, workspaceId: record.workspaceId },
        onTerminal: async event => { await this.recorder.markTerminal(record.workspaceId, input.operationId, event); } });
    } catch (error) { await this.recorder.markSpawnFailed(record); throw error; }
    try { await this.recorder.markRunning(record, sessionId); }
    catch {
      await this.recorder.markPersistenceDegraded(record.workspaceId, input.operationId);
      throw new McpToolError("persistence_unavailable", "Review started but tracking persistence failed; inspect this session and never start a replacement", { sessionId, ...input });
    }
    return { status: "accepted", taskId: input.taskId, operationId: input.operationId, sessionId,
      nextCall: { tool: "read_process", arguments: { sessionId, taskId: input.taskId, operationId: input.operationId, waitMode: "terminal", waitMs: 30000 } } };
  }
}
