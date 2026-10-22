import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import type { OperatorApprovalService } from "./operator-approval.js";
import { requestPrincipal } from "./request-principal.js";
import { createCachedToolRegistrar, TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";
import { runTool } from "./tool-result.js";

export function createApprovalToolRegistrar(config: AppConfig, service: OperatorApprovalService) {
  return createCachedToolRegistrar(server => {
    if (!config.operatorApprovalEnabled) return;
    server.registerTool("request_operator_approval", {
      title: "Request operator approval for Kernel identity adoption",
      description: "Create a durable pending request bound to an active task and observed Kernel identity. Open approvalUrl for the human operator. Chat text and tool arguments cannot approve. Supports legacy identity adoption only, not arbitrary merges, reviews, or shell commands. Reuse requestId only for identical retries.",
      inputSchema: {
        taskId: z.uuid(), requestId: z.uuid(), cwd: z.string().min(1).max(4096),
        operation: z.literal("kernel_identity_adopt"),
        sourceProjectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
        legacyProjectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/),
        reason: z.string().trim().min(1).max(2048),
      }, annotations: TOOL_ANNOTATIONS.additiveIdempotentClosed, _meta: toolAuthMetadata(config),
    }, input => runTool(() => service.request(input, requestPrincipal.getStore())));
    server.registerTool("get_operator_approval", {
      title: "Read operator approval and execution state",
      description: "Read an approval owned by the current authenticated connection grant. pending is not permission to execute. unknown requires inspection and never authorizes a retry. Approval expiry is enforced at execution. This does not wake an idle chat.",
      inputSchema: { approvalRequestId: z.uuid() },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed, _meta: toolAuthMetadata(config),
    }, ({ approvalRequestId }) => runTool(() => service.get(approvalRequestId, requestPrincipal.getStore())));
    server.registerTool("execute_approved_operation", {
      title: "Execute an approved Kernel identity adoption",
      description: "Consume a human-approved request exactly once, recheck its task and identity, then run fixed Kernel identity approve, repair, and status commands. Returns a managed session; poll get_operator_approval. Reuse operationId for an exact retry. Never create another operationId for an uncertain execution. Root shell tools remain unrestricted; this bridge supplies application consent and audit, not OS isolation.",
      inputSchema: { approvalRequestId: z.uuid(), operationId: z.uuid() },
      annotations: TOOL_ANNOTATIONS.destructiveIdempotentClosed, _meta: toolAuthMetadata(config),
    }, ({ approvalRequestId, operationId }) => runTool(() => service.execute(approvalRequestId, operationId, requestPrincipal.getStore())));
  });
}
