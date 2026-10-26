import { requestMetrics } from "../telemetry.js";

// Fixed dimensions only. These counters never contain identities, paths or bodies.
export interface ContinuityMetrics {
  indexHits?: number; indexRebuilds?: number; indexInvalidations?: number;
  observationMs?: number;
  observationCleanupMs?: number;
  taskLookupMs?: number;
  receiptReadMs?: number;
  ownerValidationMs?: number;
  durabilityMs?: number;
  persistenceMs?: number;
  gitMs?: number;
  evidenceMs?: number;
  receiptReads?: number;
  syncCalls?: number;
}

export const continuityMetricKeys = ["indexHits","indexRebuilds","indexInvalidations","observationMs", "observationCleanupMs", "taskLookupMs", "receiptReadMs", "ownerValidationMs",
  "durabilityMs", "persistenceMs", "gitMs", "evidenceMs", "receiptReads", "syncCalls"] as const;

export function countContinuity(key: keyof ContinuityMetrics, value = 1): void {
  const request = requestMetrics.getStore();
  if (!request) return;
  const metrics = request.continuity ??= {};
  metrics[key] = (metrics[key] ?? 0) + value;
}

export async function measureContinuity<T>(key: keyof ContinuityMetrics, operation: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try { return await operation(); }
  finally { countContinuity(key, performance.now() - started); }
}

export function measureOwnership<T>(operation: () => T): T {
  const started = performance.now();
  try { return operation(); }
  finally { countContinuity("ownerValidationMs", performance.now() - started); }
}
