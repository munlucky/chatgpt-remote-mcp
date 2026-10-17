export class McpToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

const loggedErrorCodes = new Set([
  "file_missing", "permission_denied", "replacement_mismatch", "patch_check_failed", "patch_apply_failed",
  "process_session_unknown", "revision_conflict", "idempotency_conflict", "tracking_required",
  "completion_checkpoint_conflict", "unresolved_execution", "persistence_unavailable", "storage_full",
  "state_corrupt", "spawn_failed", "timed_out", "process_error", "other",
]);

export function safeErrorCode(code: unknown): string {
  if (code === "ENOENT") return "file_missing";
  if (code === "EACCES" || code === "EPERM") return "permission_denied";
  return typeof code === "string" && loggedErrorCodes.has(code) ? code : "other";
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
