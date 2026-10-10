import type { TaskRecord, WorkspaceObservation } from "./task-types.js";

// This view is a read-only hint. Preserve uncertainty and counts even when
// details are omitted; a summary must never turn a partial view into permission.
export function summarizeContext(context: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  const omitted: Record<string, number> = {};
  const text = (value: string, key: string, limit = 1024): string => {
    if (value.length <= limit) return value;
    omitted[key] = value.length - limit;
    return value.slice(0, limit);
  };
  const items = <T>(values: T[], key: string, limit: number): T[] => {
    if (values.length > limit) omitted[key] = values.length - limit;
    return values.slice(0, limit);
  };
  const task = context.task as TaskRecord | null;
  const observation = context.observation as WorkspaceObservation | undefined;
  const executions = context.executions as {
    running: Record<string, unknown>[];
    unsettled: Record<string, unknown>[];
    recent: Record<string, unknown>[];
    total?: number;
  };
  const execution = (record: Record<string, unknown>) => ({
    operationId: record.operationId,
    sessionId: record.sessionId,
    state: record.state,
    toolKind: record.toolKind,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    persistenceState: record.persistenceState,
    errorCode: record.errorCode,
    callerResolution: (record.callerResolution as { resolution?: string } | undefined)?.resolution,
  });
  const summary: Record<string, unknown> = {
    ...context,
    format: "summary",
    task: task ? {
      taskId: task.taskId,
      status: task.status,
      revision: task.revision,
      objective: text(task.objective, "objective", 2048),
      updatedAt: task.updatedAt,
      checkpoint: {
        phase: task.checkpoint.phase,
        current: text(task.checkpoint.current, "current", 2048),
        completed: items([...task.checkpoint.completed].reverse(), "completed", 5).reverse().map((value, index) => text(value, `completed.${index}`, 256)),
        remaining: items(task.checkpoint.remaining, "remaining", 10).map((value, index) => text(value, `remaining.${index}`, 256)),
        blockers: items(task.checkpoint.blockers, "blockers", 10).map((value, index) => text(value, `blockers.${index}`, 256)),
      },
    } : null,
    ...(observation ? { observation: {
      observedAt: observation.observedAt,
      head: observation.head,
      branch: observation.branch,
      fingerprint: observation.fingerprint,
      completeness: observation.completeness,
      reasons: observation.reasons,
      inspectedFiles: observation.inspectedFiles,
    } } : {}),
    executions: {
      total: executions.total ?? 0,
      counts: { running: executions.running.length, unsettled: executions.unsettled.length, recentReturned: Math.min(executions.recent.length, 5) },
      running: items(executions.running, "runningExecutions", 10).map(execution),
      unsettled: items(executions.unsettled, "unsettledExecutions", 10).map(execution),
      recent: items(executions.recent, "recentExecutions", 5).map(execution),
    },
    recovery: {
      automaticRetryAllowed: false,
      checkpointIsCallerSummary: true,
      nextCall: task
        ? { tool: "get_work_context", arguments: { taskId: task.taskId, format: "full" } }
        : undefined,
      instruction: "Inspect current workspace and existing receipts before deciding. Do not replay prepared/running/unknown executions, infer task completion from process exit, bypass user-input waits, or reissue an existing project task contract.",
    },
    summaryOmissions: omitted,
  };
  if (Array.isArray(context.candidates)) {
    summary.candidates = items(context.candidates as Record<string, unknown>[], "candidates", 10)
      .map((candidate, index) => ({ ...candidate, objective: text(String(candidate.objective ?? ""), `candidate.${index}.objective`, 256) }));
  }
  // Rare oversized paths/candidate metadata must fail explicitly, not leak an
  // unbounded response or silently omit unsettled execution counts.
  if (Buffer.byteLength(JSON.stringify(summary)) > maxBytes) {
    return {
      format: "summary",
      selection: context.selection,
      task: task ? { taskId: task.taskId, status: task.status, revision: task.revision } : null,
      executions: { total: executions.total ?? 0, counts: (summary.executions as Record<string, unknown>).counts },
      drift: context.drift,
      evidence: context.evidence,
      resume: "inspection_required",
      summaryOmissions: { ...omitted, sizeLimit: 1 },
      recovery: summary.recovery,
    };
  }
  return summary;
}
