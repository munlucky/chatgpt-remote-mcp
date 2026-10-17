import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

// Uses a new disposable workspace only. No existing consumer task is selected.
export async function verifyContinuitySmoke(call) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-terminal-probe-'));
  const terminal = { phase: 'completed', current: 'synthetic checks verified', completed: ['synthetic execution checks'], remaining: [], blockers: [], changedPaths: [] };
  try {
    const created = (await call('checkpoint_work', { mode: 'create', cwd: root, requestId: randomUUID(), objective: 'deployment synthetic continuity check',
      checkpoint: { ...terminal, phase: 'verify', remaining: ['verify synthetic executions'], evidenceRefs: [] } })).data;
    const operations = [];
    for (const [script, timeoutMs] of [['process.exit(0)', 0], ['process.exit(7)', 0], ['setTimeout(()=>{},1000)', 100]]) {
      const operationId = randomUUID(); operations.push(operationId);
      await call('run_script', { runtime: 'node', script, workdir: root, taskId: created.taskId, operationId, timeoutMs, yieldTimeMs: 3000 });
    }
    const before = (await call('get_work_context', { taskId: created.taskId, format: 'full' })).data;
    const receipts = before.executions.recent;
    if (receipts.length !== 3 || !receipts.some(r => r.exitCode === 7) || !receipts.some(r => r.timedOut)
      || receipts.some(r => r.bootId !== receipts[0].bootId || !r.sessionId || !operations.includes(r.operationId))) throw new Error('Synthetic receipt check failed');
    const complete = { taskId: created.taskId, requestId: randomUUID(), expectedRevision: 1, outcome: 'completed', summary: 'synthetic deployment checks passed',
      finalCheckpoint: terminal, evidenceRefs: operations.map(operationId => ({ kind: 'receipt', operationId })) };
    const result = (await call('complete_work', complete)).data;
    const replay = (await call('complete_work', complete)).data;
    const context = (await call('get_work_context', { taskId: created.taskId, format: 'full' })).data;
    if (result.status !== 'completed' || replay.revision !== result.revision || context.task.status !== 'completed'
      || context.task.checkpoint.phase !== 'completed' || context.task.checkpoint.remaining.length || context.warnings.length) throw new Error('Synthetic final checkpoint check failed');
    return { terminalSmokeVerified: true, syntheticExecutions: 3, syntheticTimeouts: 1, terminalReplayVerified: true, sharedReceiptBootVerified: true };
  } finally { await rm(root, { recursive: true, force: true }); }
}
