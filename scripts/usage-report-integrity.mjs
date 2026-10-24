import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { validateExecution, validateWorkspace } from './usage-report-storage-schema.mjs';

export const processKey = e => e.bootId && e.sessionId ? JSON.stringify([e.bootId, e.sessionId]) : null;
const logicalKey = e => e.correlation?.workspaceId && e.correlation?.operationId
  ? JSON.stringify([e.correlation.workspaceId, e.correlation.operationId]) : null;
const maximum = xs => xs.length ? xs.reduce((a,b) => Math.max(a,b), -Infinity) : null;
const sum = values => values.length ? values.reduce((a, b) => a + b, 0) : null;
const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1] : null;

export function analyze(events, selected, since, until) {
  const lifecycles = new Map();
  for (const e of events.filter(e => ['process_started', 'process_terminal'].includes(e.event))) {
    const key = processKey(e);
    if (!key) continue;
    if (!lifecycles.has(key)) lifecycles.set(key, { started: [], terminal: [] });
    lifecycles.get(key)[e.event === 'process_started' ? 'started' : 'terminal'].push(e);
  }
  const selectedKeys = new Set(selected.filter(e => e.event.startsWith('process_')).map(processKey).filter(Boolean));
  for (const e of selected.filter(e => e.event === 'mcp_request' && e.correlation?.sessionId)) {
    const key = processKey({ bootId: e.correlation.executionBootId, sessionId: e.correlation.sessionId });
    if (key && lifecycles.has(key)) selectedKeys.add(key);
  }
  const logical = new Map(), historyLogical = new Map();
  for (const e of events.filter(e => ['process_started','process_terminal'].includes(e.event))) {
    const operation = logicalKey(e), process = processKey(e);
    if (!operation || !process) continue;
    if (!historyLogical.has(operation)) historyLogical.set(operation, new Set());
    historyLogical.get(operation).add(process);
  }
  const integrity = [];
  for (const key of selectedKeys) {
    const life = lifecycles.get(key), start = life.started[0], end = life.terminal[0], e = start ?? end;
    const fingerprint = item => JSON.stringify(Object.fromEntries(Object.entries(item).sort(([a],[b]) => a.localeCompare(b))));
    const conflicts = [life.started, life.terminal].some(list => new Set(list.map(fingerprint)).size > 1);
    const duplicateEvents = life.started.length + life.terminal.length - Number(Boolean(start)) - Number(Boolean(end));
    const bindingMismatch = start && end && (logicalKey(start) !== logicalKey(end) || start.correlation?.taskId !== end.correlation?.taskId);
    const state = conflicts || bindingMismatch ? 'event_conflict'
      : !e.schemaVersion || !e.correlation?.workspaceId || !e.correlation?.operationId ? 'legacy_or_untracked'
      : !end ? 'missing_terminal_unknown' : !start ? 'missing_start_unknown'
      : Date.parse(end.timestamp) < since || Date.parse(end.timestamp) >= until ? 'terminal_outside_window' : 'lifecycle_matched';
    integrity.push({ bootId: e.bootId, sessionId: e.sessionId, correlation: e.correlation ?? null, state, duplicateEvents,
      start: start ?? null, terminal: end ?? null });
    const operation = logicalKey(e);
    if (operation) {
      if (!logical.has(operation)) logical.set(operation, new Set());
      logical.get(operation).add(key);
    }
  }
  const requests = selected.filter(e => e.event === 'mcp_request');
  for (const e of requests) if (logicalKey(e) && !logical.has(logicalKey(e))) logical.set(logicalKey(e), new Set());
  const tasks = new Map();
  for (const e of selected) {
    const c = e.correlation;
    if (!c?.taskId || !c.workspaceId) continue;
    const key = JSON.stringify([c.workspaceId, c.taskId]);
    if (!tasks.has(key)) tasks.set(key, { taskId: c.taskId, workspaceId: c.workspaceId, requests: [], events: [] });
    const task = tasks.get(key); task.events.push(Date.parse(e.timestamp));
    if (e.event === 'mcp_request') task.requests.push(e);
  }
  const reads = requests.filter(e => e.toolName === 'read_process');
  const readsByProcess = new Map(), retentionByProcess = new Map();
  for (const e of requests) {
    const key = processKey({ bootId: e.correlation?.executionBootId ?? e.bootId, sessionId: e.correlation?.sessionId });
    if (!key) continue;
    if (Number.isFinite(e.processRead?.droppedOutputBytes)) retentionByProcess.set(key, Math.max(retentionByProcess.get(key) ?? 0, e.processRead.droppedOutputBytes));
    if (e.toolName === 'read_process') {
      if (!readsByProcess.has(key)) readsByProcess.set(key, []);
      readsByProcess.get(key).push(e);
    }
  }
  const perExecution = [...selectedKeys].map(key => {
    const [bootId, sessionId] = JSON.parse(key);
    const calls = readsByProcess.get(key) ?? [];
    return { bootId, sessionId, calls: calls.length,
      emptyRunning: calls.filter(e => e.processRead?.running && e.processRead.outputBytes === 0).length,
      terminalOutputReads: calls.filter(e => e.processRead?.running === false && e.processRead.outputBytes > 0).length,
      unobserved: calls.filter(e => !e.processRead).length };
  });
  const ended = integrity.map(e => e.terminal).filter(Boolean);
  const durations = ended.map(e => Date.parse(e.endedAt ?? e.timestamp) - Date.parse(e.startedAt)).filter(n => Number.isFinite(n) && n >= 0);
  return {
    integrity, counts: { httpRequests: new Set(requests.map(e => e.requestId).filter(Boolean)).size,
      requestsWithoutId: requests.filter(e => !e.requestId).length, logicalExecutions: logical.size,
      processExecutions: selectedKeys.size,
      repeatedOperationExecutions: [...logical.keys()].filter(key => historyLogical.get(key)?.size > 1).length },
    correlationSources: { direct: requests.filter(e => e.correlationSource === 'direct').length,
      derivedFromLifecycle: requests.filter(e => e.correlationSource === 'derived_from_lifecycle').length,
      unlinked: requests.filter(e => e.correlationSource === 'unlinked').length },
    microExecutions: { measuredTerminal: durations.length, atMostFiveSeconds: durations.filter(n => n <= 5000).length,
      ratio: durations.length ? durations.filter(n => n <= 5000).length / durations.length : null },
    polling: { readProcessCalls: reads.length, perExecution,
      unlinkedCalls: reads.filter(e => !e.correlation?.sessionId).length,
      readProcessPerExecution: selectedKeys.size ? reads.length / selectedKeys.size : null },
    output: { generatedBytes: sum(ended.map(e => e.totalOutputBytes).filter(Number.isFinite)),
      httpResponseBytes: sum(requests.map(e => e.responseBytes).filter(Number.isFinite)),
      deliveredProcessBytes: sum(requests.map(e => e.processRead?.outputBytes).filter(Number.isFinite)),
      observedRetentionLossBytes: sum([...retentionByProcess.values()]),
      note: 'Delivered bytes include caller-requested rereads. Retention loss is the maximum observed per process, not an additive per-read loss.' },
    tasks: [...tasks.values()].map(task => {
      const times = [...new Set(task.events)].sort((a,b) => a-b);
      const gaps = times.slice(1).map((t,i) => t-times[i]);
      const calls = tool => ({ calls: task.requests.filter(e => e.toolName === tool).length,
        observedFailures: task.requests.filter(e => e.toolName === tool && (e.toolError === true || e.status >= 400)).length });
      return { taskId: task.taskId, workspaceId: task.workspaceId, context: calls('get_work_context'), checkpoint: calls('checkpoint_work'),
        observationGaps: { samples: gaps.length, p50Ms: percentile(gaps,.5), p95Ms: percentile(gaps,.95), maxMs: gaps.length ? maximum(gaps) : null,
          first: times.length ? new Date(times[0]).toISOString() : null, last: times.length ? new Date(times.at(-1)).toISOString() : null,
          note: 'Event gaps include user/model work and silent execution; they do not measure wasted time.' } };
    }),
  };
}

// Read only the selected execution scope. Never import a writable TaskStore.
export async function compareReceipts(entries, stateDirectory) {
  if (!stateDirectory) return entries.map(({ start, terminal, ...entry }) => ({ ...entry, receipt: 'not_requested' }));
  return Promise.all(entries.map(async ({ start, terminal, ...entry }) => {
    const { workspaceId, operationId } = entry.correlation ?? {};
    if (!/^[a-f0-9]{32}$/.test(workspaceId ?? '') || !/^[a-f0-9-]{36}$/i.test(operationId ?? '')) return { ...entry, receipt: 'legacy_or_untracked' };
    const file = path.join(stateDirectory, 'workspaces', workspaceId, 'executions', `${operationId}.json`);
    const workspace = path.dirname(path.dirname(file));
    const pendingJournal = async () => {
      try { return (await readdir(path.join(workspace, 'transactions'))).length > 0; }
      catch (error) { if (error.code === 'ENOENT') return false; throw error; }
    };
    const classify = record => {
      if (!validateExecution(record)) return 'schema_unknown';
      if (record.workspaceId !== workspaceId || record.operationId !== operationId || record.taskId !== entry.correlation.taskId
        || record.bootId !== entry.bootId) return 'identity_mismatch';
      if (record.persistenceState !== 'ok' || ['prepared','unknown'].includes(record.state)) return 'uncertain_or_degraded';
      if (record.sessionId !== entry.sessionId) return 'identity_mismatch';
      if (record.state === 'running') return terminal ? 'outcome_mismatch' : 'running';
      if (!terminal) return 'log_evidence_missing';
      if (record.exitCode !== terminal.exitCode || record.signal !== terminal.signal || record.timedOut !== terminal.timedOut
        || record.outputBytes !== terminal.totalOutputBytes || record.state !== (terminal.spawnFailed ? 'spawn_failed' : 'exited')) return 'outcome_mismatch';
      return 'matched';
    };
    try {
      if (await pendingJournal()) return { ...entry, receipt: 'pending_journal_inconclusive' };
      const state = validateWorkspace(JSON.parse(await readFile(path.join(workspace, 'state.json'), 'utf8')));
      if (!state || state.workspace.workspaceId !== workspaceId || !state.tasks[entry.correlation.taskId]) return { ...entry, receipt: 'owner_unknown' };
      const first = await readFile(file, 'utf8'); let result = classify(JSON.parse(first));
      if (result.endsWith('mismatch')) {
        const second = await readFile(file, 'utf8');
        result = second !== first ? 'changed_during_observation' : classify(JSON.parse(second));
      }
      if (await pendingJournal()) result = 'pending_journal_inconclusive';
      return { ...entry, receipt: result };
    } catch (error) { return { ...entry, receipt: error.code === 'ENOENT' ? 'missing_unknown' : 'unreadable_unknown' }; }
  }));
}

export async function diagnosticCoverage(directory, events, buildId, since, until) {
  const snapshots = [];
  for (const name of (await readdir(directory)).filter(n => /^diagnostics-[a-f0-9-]+\.json$/i.test(n))) {
    try { snapshots.push(JSON.parse(await readFile(path.join(directory, name), 'utf8'))); } catch { /* absent evidence */ }
  }
  const boots = [...new Set(events.map(e => e.bootId).filter(Boolean))];
  return { requestedPeriod: { since: new Date(since).toISOString(), until: new Date(until).toISOString() },
    boots: boots.map(bootId => {
      const s = snapshots.find(s => s.bootId === bootId && (!buildId || s.buildId === buildId));
      const times = events.filter(e => e.bootId === bootId).map(e => Date.parse(e.timestamp));
      const covered = s && s.schemaVersion === 2 && s.pendingEvents === 0 && Date.parse(s.since) <= times.reduce((a,b) => Math.min(a,b), Infinity)
        && Date.parse(s.until) >= maximum(times) && Number.isSafeInteger(s.droppedEvents) && Number.isSafeInteger(s.writeFailures);
      return { bootId, status: covered ? s.droppedEvents || s.writeFailures ? 'loss_observed' : 'covered_observations' : 'unknown',
        since: s?.since ?? null, until: s?.until ?? null, droppedEvents: covered ? s.droppedEvents : null, writeFailures: covered ? s.writeFailures : null };
    }), note: 'Counters cover only each recorded boot interval. They do not prove completeness outside that interval or absence of wholly missing boots.' };
}
