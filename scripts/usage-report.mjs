import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { readEvent } from './usage-report-input.mjs';
import { analyze, compareReceipts, diagnosticCoverage, processKey } from './usage-report-integrity.mjs';
const dir = process.argv[2] || '/var/log/mcp-usage';
const args = process.argv.slice(3);
const options = {};
const hours = args[0] && !args[0].startsWith('--') ? Number(args.shift()) : 24;
if (!Number.isFinite(hours) || hours <= 0) throw new Error('hours must be positive');
while (args.length) {
  const key = args.shift();
  if (!['--since','--until','--task-id','--workspace-id','--build-id','--receipts-dir'].includes(key) || !args.length || args[0].startsWith('--') || options[key]) throw new Error('Unknown, repeated or incomplete option');
  options[key] = args.shift();
}
const explicitRange = Boolean(options['--since'] || options['--until']);
const since = explicitRange ? Date.parse(options['--since']) : Date.now() - hours * 3600000;
const until = explicitRange ? Date.parse(options['--until']) : Date.now();
if (explicitRange && (![options['--since'], options['--until']].every(v => typeof v === 'string' && /(?:[zZ]|[+-]\d\d:\d\d)$/.test(v)) || !Number.isFinite(since) || !Number.isFinite(until) || since >= until)) throw new Error('Use --since ISO_TIMESTAMP --until ISO_TIMESTAMP with explicit time zones and increasing boundaries');
const inWindow = e => Date.parse(e.timestamp) >= since && Date.parse(e.timestamp) < until;
const inScope = e => (!options['--task-id'] || e.correlation?.taskId === options['--task-id'])
  && (!options['--workspace-id'] || e.correlation?.workspaceId === options['--workspace-id'])
  && (!options['--build-id'] || e.buildId === options['--build-id']);
const all = [];
const inputCoverage = [];
const groups = new Map(); let malformed = 0; let samples = 0; let excludedProbes = 0;
const started = new Map(), terminal = new Map();
for (const file of (await readdir(dir)).filter(f => /^requests\.jsonl(?:\.\d+)?$/.test(f))) {
  const coverage = { file, bytesRead: 0, status: 'read', incompleteLastLine: false };
  inputCoverage.push(coverage);
  try {
    const before = await stat(path.join(dir,file));
    const stream = createReadStream(path.join(dir,file));
    let lastByte, invalidLast = false;
    stream.on('data', chunk => { coverage.bytesRead += chunk.length; lastByte = chunk.at(-1); });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      invalidLast = false;
      let e;
      try { e = readEvent(JSON.parse(line)); } catch { malformed++; invalidLast = true; continue; }
      if (!e || !e.timestamp) { malformed++; continue; }
      if (e.trafficClass !== 'probe') all.push(e);
      if (inWindow(e) && inScope(e) && e.trafficClass === 'probe') excludedProbes++;
    }
    if (lastByte !== undefined && lastByte !== 10 && invalidLast) { coverage.incompleteLastLine = true; malformed--; }
    const after = await stat(path.join(dir,file));
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) coverage.status = 'changed_during_scan';
  } catch { coverage.status = 'unavailable_or_rotated'; }
}
// A reply can be lost before selection. Join only a single validated lifecycle binding
// with the exact server request ID and boot; never copy user request arguments.
const requestBindings = new Map();
for (const e of all.filter(e => e.event === 'process_started' && e.requestId && e.correlation)) {
  const key = JSON.stringify([e.bootId, e.requestId]);
  if (!requestBindings.has(key)) requestBindings.set(key, e.correlation);
  else if (JSON.stringify(requestBindings.get(key)) !== JSON.stringify(e.correlation)) requestBindings.set(key, null);
}
for (const e of all.filter(e => e.event === 'mcp_request' && !e.correlation?.taskId)) {
  const binding = requestBindings.get(JSON.stringify([e.bootId, e.requestId]));
  if (binding) { e.correlation = binding; e.correlationSource = "derived_from_lifecycle"; }
}
for (const e of all.filter(e => e.event === "mcp_request")) e.correlationSource ??= e.correlation?.taskId ? "direct" : "unlinked";
const selected = all.filter(e => inWindow(e) && inScope(e));
for (const e of selected) {
    if (e.event === 'process_started') { started.set(processKey(e) ?? `legacy-start-${started.size}`, e); continue; }
    if (e.event === 'process_terminal') { terminal.set(processKey(e) ?? `legacy-end-${terminal.size}`, e); continue; }
    if (e.event !== 'mcp_request') continue;
    if (!Number.isFinite(e.durationMs)) { malformed++; continue; }
    const clientClass = ['codex', 'openai_mcp', 'other'].includes(e.clientClass) ? e.clientClass : 'legacy_unknown';
    const key = `${e.buildId}|${clientClass}|${e.toolName || e.rpcMethod || 'http'}`;
    if (!groups.has(key)) groups.set(key, { buildId: e.buildId, clientClass, call: e.toolName || e.rpcMethod || 'http', count: 0, errors: 0, httpFailures: 0, toolErrors: 0, toolSucceeded: 0, toolUnobserved: 0, aborted: 0, duration: [], overhead: [], setup: [], tool: [], bytes: [] });
    const g = groups.get(key); g.count++; samples++;
    if (Number.isFinite(e.toolMs)) g.overhead.push(Math.max(0,e.durationMs-e.toolMs));
    if (e.status >= 400 || e.toolError === true) g.errors++;
    if (e.status >= 400) g.httpFailures++;
    if (e.toolError === true) g.toolErrors++;
    else if (e.toolError === false) g.toolSucceeded++;
    else if (e.toolName) g.toolUnobserved++;
    if (e.outcome === 'aborted') g.aborted++;
    for (const [field,value] of [['duration',e.durationMs],['setup',e.setupMs],['tool',e.toolMs],['bytes',e.responseBytes]]) if (Number.isFinite(value)) g[field].push(value);
}
const countValues = values => Object.fromEntries([...new Set(values)].sort().map(key => [key, values.filter(value => value === key).length]));
const requests = selected.filter(e => e.event === 'mcp_request');
const toolFailures = requests.filter(e => e.toolError === true);
const errorDistribution = { denominator: toolFailures.length, codes: countValues(toolFailures.map(e => e.errorCode ?? 'unknown_code')), categories: countValues(toolFailures.map(e => e.errorCategory ?? 'unobserved')) };
const continuityKeys = ['indexHits','indexRebuilds','indexInvalidations','observationMs','observationCleanupMs','taskLookupMs','receiptReadMs','ownerValidationMs','durabilityMs','persistenceMs','gitMs','evidenceMs','receiptReads','syncCalls'];
const continuity = Object.fromEntries(continuityKeys.map(key => { const values = requests.map(e => e.continuity?.[key]).filter(Number.isFinite); return [key, { samples: values.length, unobserved: requests.length - values.length, total: values.length ? values.reduce((a,b)=>a+b,0) : null, p50: metricPercentile(values,.5), p95: metricPercentile(values,.95) }]; }));
function metricPercentile(values,p) { return values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] : null; }
const analysis = analyze(all, selected, since, until);
analysis.integrity = await compareReceipts(analysis.integrity, options['--receipts-dir']);
analysis.diagnostics = await diagnosticCoverage(dir, selected, options['--build-id'], since, until);
const observationStatus = !inputCoverage.length || malformed > 0
  || inputCoverage.some(file => file.status !== 'read' || file.incompleteLastLine)
  || analysis.integrity.some(entry => ['changed_during_observation','pending_journal_inconclusive'].includes(entry.receipt))
  ? 'inconclusive' : 'observed';
const percentile = (values,p) => values.length ? +[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)].toFixed(2) : null;
const values = [...terminal.values()];
const failed = e => (Number.isInteger(e.exitCode) && e.exitCode !== 0) || e.timedOut === true || e.spawnFailed === true || Boolean(e.signal);
const succeeded = e => e.exitCode === 0 && !failed(e);
const duration = e => {
  const ms = Date.parse(e.endedAt ?? e.timestamp) - Date.parse(e.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
const timeoutLimits = new Map();
for (const e of values) {
  const timeoutMs = Number.isSafeInteger(e.timeoutMs) && e.timeoutMs >= 0 ? e.timeoutMs : null;
  const key = timeoutMs ?? 'unknown';
  if (!timeoutLimits.has(key)) timeoutLimits.set(key, { timeoutMs, policy: timeoutMs === null ? 'unknown' : timeoutMs === 0 ? 'unlimited' : 'limited', terminal: 0, timedOut: 0, failed: 0, cumulativeExecutionMs: 0, measuredDurations: 0 });
  const group = timeoutLimits.get(key); group.terminal++;
  if (e.timedOut) group.timedOut++;
  if (failed(e)) group.failed++;
  const ms = duration(e);
  if (ms !== null) { group.cumulativeExecutionMs += ms; group.measuredDurations++; }
}
for (const group of timeoutLimits.values()) if (!group.measuredDurations) group.cumulativeExecutionMs = null;
const failureDurations = values.filter(failed).map(duration).filter(ms => ms !== null);
const successDurations = values.filter(succeeded).map(duration).filter(ms => ms !== null);
const executions = {
  started: started.size,
  terminal: terminal.size,
  succeeded: values.filter(succeeded).length,
  failed: values.filter(failed).length,
  unknownOutcome: values.filter(e => !failed(e) && !succeeded(e)).length,
  nonzeroExit: values.filter(e => Number.isInteger(e.exitCode) && e.exitCode !== 0).length,
  signaled: values.filter(e => Boolean(e.signal)).length,
  timedOut: [...terminal.values()].filter(e => e.timedOut).length,
  spawnFailed: [...terminal.values()].filter(e => e.spawnFailed).length,
  withoutTerminalInWindow: [...started.keys()].filter(key => !terminal.has(key)).length,
  timeoutLimits: [...timeoutLimits.values()].sort((a, b) => (a.timeoutMs ?? Infinity) - (b.timeoutMs ?? Infinity)),
  successfulExecutionDuration: { samples: successDurations.length, p50Ms: percentile(successDurations, .5), p95Ms: percentile(successDurations, .95), cumulativeExecutionMs: successDurations.length ? successDurations.reduce((a,b) => a+b, 0) : null },
  failedExecutionDuration: { samples: failureDurations.length, p50Ms: percentile(failureDurations,.5), p95Ms: percentile(failureDurations,.95), cumulativeExecutionMs: failureDurations.length ? failureDurations.reduce((a,b) => a+b,0) : null },
  lifecycleJoin: 'Exact (bootId, sessionId) only. Historical receipt/log boot mismatches remain legacy; never merge boots automatically.',
  durationNote: 'Cumulative measured execution durations can overlap. They are neither wall-clock delay nor time wasted. Failure axes can overlap; failed counts each terminal execution once.',
  note: 'Metadata observations only, not task authority. Missing terminal events may mean running work, crash, log retention, or observation loss; never automatically retry. Legacy requests have no lifecycle coverage.',
};
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), hours, period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() }, filters: { taskId: options['--task-id'] ?? null, workspaceId: options['--workspace-id'] ?? null, buildId: options['--build-id'] ?? null }, samples, excludedProbes, malformed, inputCoverage, observationStatus, executions, errorDistribution, continuity, ...analysis, note: 'Retained rolling window only; marked probes excluded (historical marks may be spoofed). Overhead is per-request duration minus tool time, not a difference of percentiles. Sparse samples and different commands are not comparable performance proof. Tool time includes deliberate execution waits.', groups: [...groups.values()].map(g => ({ buildId:g.buildId, clientClass:g.clientClass, call:g.call, count:g.count, errors:g.errors, httpFailures:g.httpFailures, toolErrors:g.toolErrors, toolSucceeded:g.toolSucceeded, toolUnobserved:g.toolUnobserved, errorCodes: countValues(toolFailures.filter(e => e.buildId === g.buildId && (e.toolName || e.rpcMethod || 'http') === g.call && (['codex','openai_mcp','other'].includes(e.clientClass) ? e.clientClass : 'legacy_unknown') === g.clientClass).map(e => e.errorCode ?? 'unknown_code')), aborted:g.aborted, p50Ms:percentile(g.duration,.5), p95Ms:percentile(g.duration,.95), setupP95Ms:percentile(g.setup,.95), overheadP95Ms:percentile(g.overhead,.95), toolP95Ms:percentile(g.tool,.95), responseBytesP95:percentile(g.bytes,.95) })).sort((a,b)=>b.count-a.count) }, null, 2));
