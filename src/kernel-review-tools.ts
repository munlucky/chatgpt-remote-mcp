import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import type { KernelReviewService } from "./kernel-review.js";
import { createCachedToolRegistrar, TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";
import { runTool } from "./tool-result.js";

export function createKernelReviewToolRegistrar(config: AppConfig, service: KernelReviewService) {
  return createCachedToolRegistrar(server => {
    if (!config.kernelReview.enabled) return;
    server.registerTool("get_kernel_review_status", {
      title: "Check independent Kernel review availability",
      description: "Check Kernel/Codex and native host review availability before project mutations. Set probeModelTools=true for an actual read-only model/tool test; this consumes Codex usage and catches code-mode-host failures that protocol checks cannot detect. No project files are changed. A readiness result never satisfies a security review.",
      inputSchema: { cwd: z.string().min(1).max(4096).describe("Exact Kernel project root in the service filesystem; native paths are mapped by operator configuration."),
        probeModelTools: z.boolean().default(false).describe("Run a bounded model turn and require observed successful read-only command execution; consumes Codex usage. Use before a task requiring independent review.") },
      annotations: { ...TOOL_ANNOTATIONS.readOnlyClosed, openWorldHint: true }, _meta: toolAuthMetadata(config),
    }, ({ cwd, probeModelTools }) => runTool(() => service.status(cwd, probeModelTools)));
    server.registerTool("start_kernel_review", {
      title: "Run independent Kernel security review",
      description: "Run the existing Run's independent review through a fresh read-only Codex session and official Kernel Host ingestion. A fixed failed security review may be reviewed again only after a newer mutation and fresh hard proof. Requires an active continuity task and exact operationId retries. Caller cannot supply a verdict, reviewer identity, model, approval, or receipt. receipt-recorded may contain a failed review and is never Kernel final completion. Never retry uncertain executions with a new operationId.",
      inputSchema: {
        cwd: z.string().min(1).max(4096).describe("Exact project path used to bind the existing Kernel Run; continuity aliases do not rewrite it."),
        runId: z.string().regex(/^run-[A-Za-z0-9-]{1,100}$/).describe("Existing Kernel Run requiring independent review, or a failed security judgment fixed with a newer mutation and fresh hard proof."),
        taskId: z.uuid().describe("Existing active Moonremote continuity task for this workspace."),
        operationId: z.uuid().describe("Stable review execution ID; reuse only for an identical retry, never to replay an uncertain execution."),
      },
      annotations: { ...TOOL_ANNOTATIONS.additiveIdempotentClosed, openWorldHint: true }, _meta: toolAuthMetadata(config),
    }, input => runTool(() => service.start(input)));
  });
}
