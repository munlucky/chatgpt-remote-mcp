import type { ExecutionRecord } from "./task-types.js";

// Locators are derived hints. Every returned receipt is read from the original.
export type ReceiptLocator = Pick<ExecutionRecord, "operationId" | "taskId" | "state" | "preparedAt">;
export class WorkspaceExecutionIndex {
  readonly byOperation = new Map<string, ReceiptLocator>();
  readonly byTask = new Map<string, Set<string>>();
  readonly tasks = new Set<string>();

  publish(record: ExecutionRecord): void {
    const previous = this.byOperation.get(record.operationId);
    if (previous) this.byTask.get(previous.taskId)?.delete(record.operationId);
    this.byOperation.set(record.operationId, {operationId:record.operationId, taskId:record.taskId, state:record.state, preparedAt:record.preparedAt});
    let task = this.byTask.get(record.taskId);
    if (!task) { task = new Set(); this.byTask.set(record.taskId, task); }
    task.add(record.operationId);
  }

  task(taskId: string): ReceiptLocator[] {
    return [...(this.byTask.get(taskId) ?? [])].map(id => this.byOperation.get(id)!)
      .sort((a,b) => b.preparedAt.localeCompare(a.preparedAt) || a.operationId.localeCompare(b.operationId));
  }
}
