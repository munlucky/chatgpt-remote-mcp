import { safeErrorCode } from "./errors.js";
import { continuityMetricKeys } from "./continuity/metrics.js";
import {constants} from "node:os";
import type { UsageEvent, ProcessUsageEvent, ProcessStartedEvent } from "./telemetry.js";

const tools = new Set("exec_command run_script write_stdin read_process terminate_process list_processes list_directory stat_path read_file read_files write_file replace_in_file apply_patch upload_file download_file publish_file hash_file make_directory copy_path move_path remove_path chmod_path get_work_context checkpoint_work complete_work request_operator_approval get_operator_approval execute_approved_operation".split(" "));
const methods = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]);
export function safeRpcName(value: unknown, kind: "tool" | "method"): string | null {
  if (typeof value !== "string") return null;
  return (kind === "tool" ? tools : methods).has(value) ? value : "other";
}

const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v) ? v : null;
const token = (v: unknown) => typeof v === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v) ? v : null;
const numeric = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: unknown) => typeof v === "boolean" ? v : null;
const timestamp = (v: unknown) => typeof v === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
const enumValue = (v: unknown, values: string[]) => typeof v === "string" && values.includes(v) ? v : null;

// Runtime selection is intentional. TypeScript types do not remove extra properties.
export function serializeUsageEvent(e: UsageEvent | ProcessUsageEvent | ProcessStartedEvent): Record<string, unknown> {
  const c = e.correlation;
  const result: Record<string, unknown> = {
    event: e.event, schemaVersion: 2, timestamp: timestamp(e.timestamp), requestId: uuid(e.requestId),
    buildId: token(e.buildId), bootId: uuid(e.bootId),
    toolName: safeRpcName(e.toolName, "tool"), clientClass: enumValue(e.clientClass, ["codex", "openai_mcp", "other"]),
    trafficClass: enumValue(e.trafficClass, ["probe", "usage"]),
    correlation: {
      taskId: uuid(c?.taskId), operationId: uuid(c?.operationId), sessionId: uuid(c?.sessionId), executionBootId: uuid(c?.executionBootId),
      workspaceId: typeof c?.workspaceId === "string" && /^[a-f0-9]{32}$/.test(c.workspaceId) ? c.workspaceId : null,
      unlinkedReason: enumValue(c?.unlinkedReason, ["untracked", "not_selected", "not_applicable"]),
    },
  };
  if (e.event === "mcp_request") {
    if (e.continuity) result.continuity = Object.fromEntries(continuityMetricKeys
      .filter(key => typeof e.continuity?.[key] === "number" && Number.isFinite(e.continuity[key]) && e.continuity[key]! >= 0)
      .map(key => [key, e.continuity![key]]));
    for (const key of ["status", "durationMs", "setupMs", "toolMs", "responseBytes"] as const) result[key] = numeric(e[key]);
    result.httpMethod = enumValue(e.httpMethod, ["GET", "POST", "DELETE", "OPTIONS", "HEAD", "PUT", "PATCH"]);
    result.rpcMethod = safeRpcName(e.rpcMethod, "method"); result.toolError = bool(e.toolError);
    result.outcome = enumValue(e.outcome, ["completed", "aborted"]);
    if (e.errorCode != null) result.errorCode = safeErrorCode(e.errorCode);
    result.errorCategory = enumValue(e.errorCategory, ["file_missing", "permission_denied", "tool_failure"]);
    for (const key of ["protocolHeader", "initializeProtocol"] as const) result[key] = enumValue(e[key], ["supported", "unsupported", "omitted"]);
    result.protocolVersion = typeof e.protocolVersion === "string" && /^\d{4}-\d\d-\d\d$/.test(e.protocolVersion) ? e.protocolVersion : null;
    if (e.processRead) {
      const read = e.processRead;
      const safe: Record<string, unknown> = {running:bool(read.running),hasMore:bool(read.hasMore)};
      for (const key of ["outputBytes","droppedOutputBytes","requestedAfterSeq","nextSeq"] as const) {
        const value = read[key]; safe[key] = Number.isSafeInteger(value) && value! >= 0 ? value : null;
      }
      for (const key of ["requestedWaitMs","effectiveWaitMs","responseBudgetMs"] as const) {
        const value = read[key]; safe[key] = Number.isInteger(value) && value! >= 0 && value! <= 305000 ? value : null;
      }
      safe.responseElapsedMs = typeof read.responseElapsedMs === "number" && Number.isFinite(read.responseElapsedMs) && read.responseElapsedMs >= 0 ? read.responseElapsedMs : null;
      for (const key of ["drainOnly","responseDeadlineExceeded"] as const) safe[key] = bool(read[key]);
      safe.waitMode = enumValue(read.waitMode,["output","terminal"]);
      safe.persistenceVerification = enumValue(read.persistenceVerification,["not_required","verified","pending"]);
      safe.persistenceState = enumValue(read.persistenceState,["ok","degraded"]);
      safe.outputAvailability = enumValue(read.outputAvailability,["unavailable"]);
      result.processRead = safe;
    }
  } else {
    result.sessionId = uuid(e.sessionId); result.startedAt = timestamp(e.startedAt); result.timeoutMs = numeric(e.timeoutMs);
    if (e.event === "process_terminal") {
      result.endedAt = timestamp(e.endedAt); result.exitCode = numeric(e.exitCode);
      result.signal = typeof e.signal === "string" && Object.hasOwn(constants.signals,e.signal) ? e.signal : null;
      result.timedOut = bool(e.timedOut); result.spawnFailed = bool(e.spawnFailed);
      result.totalOutputBytes = numeric(e.totalOutputBytes); if (e.errorCode != null) result.errorCode = safeErrorCode(e.errorCode);
    }
  }
  return result;
}
