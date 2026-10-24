import { requestMetrics } from "./telemetry.js";

export interface Correlation {
  taskId: string | null;
  workspaceId: string | null;
  operationId: string | null;
  sessionId: string | null;
  executionBootId: string | null;
  unlinkedReason: "untracked" | "not_selected" | "not_applicable" | null;
}

export function correlation(binding?: Partial<Correlation>): Correlation {
  return {
    taskId: binding?.taskId ?? null, workspaceId: binding?.workspaceId ?? null,
    operationId: binding?.operationId ?? null, sessionId: binding?.sessionId ?? null,
    executionBootId: binding?.executionBootId ?? null,
    unlinkedReason: binding?.taskId ? null : binding?.unlinkedReason ?? "not_selected",
  };
}

// Call only with a binding selected by the service or process manager.
export function bindRequest(binding: Partial<Correlation>): void {
  const metrics = requestMetrics.getStore();
  if (metrics) metrics.correlation = correlation(binding);
}
