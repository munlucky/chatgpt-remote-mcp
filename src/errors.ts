import errorCodes from "./error-codes.json" with { type: "json" };

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

const loggedErrorCodes = new Set(errorCodes);

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
