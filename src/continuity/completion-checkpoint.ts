import type { WorkCheckpoint } from "./task-types.js";

export type FinalCheckpoint = Omit<WorkCheckpoint, "evidenceRefs" | "executionReconciliations">;

export function completionCheckpointConflict(checkpoint: FinalCheckpoint): boolean {
  return checkpoint.phase !== "completed" || checkpoint.current.trim().length === 0
    || checkpoint.remaining.length > 0 || checkpoint.blockers.length > 0;
}
