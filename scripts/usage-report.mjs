import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
const dir = process.argv[2] || '/var/log/mcp-usage';
const explicitRange = process.argv[3] === '--since';
const hours = explicitRange ? null : Number(process.argv[3] || 24);
if (!explicitRange && (!Number.isFinite(hours) || hours <= 0)) throw new Error('hours must be positive');
const since = explicitRange ? Date.parse(process.argv[4]) : Date.now() - hours * 3600000;
const until = explicitRange ? Date.parse(process.argv[6]) : Date.now();
if (explicitRange && (process.argv[5] !== '--until' || !/[zZ]|[+-]\d\d:\d\d$/.test(process.argv[4] || '') || !/[zZ]|[+-]\d\d:\d\d$/.test(process.argv[6] || '') || !Number.isFinite(since) || !Number.isFinite(until) || since >= until)) throw new Error('Use --since ISO_TIMESTAMP --until ISO_TIMESTAMP with explicit time zones and increasing boundaries');
const groups = new Map(); let malformed = 0; let samples = 0; let excludedProbes = 0;
const started = new Map(), terminal = new Map();
for (const file of (await readdir(dir)).filter(f => /^requests\.jsonl(?:\.\d+)?$/.test(f))) {
  const reader = createInterface({ input: createReadStream(path.join(dir,file)), crlfDelay: Infinity });
  for await (const line of reader) {
    let e; try { e = JSON.parse(line); } catch { malformed++; continue; }
    if (!(Date.parse(e.timestamp) >= since && Date.parse(e.timestamp) < until)) continue;
    if (e.trafficClass === 'probe') { excludedProbes++; continue; }
    if (e.event === 'process_started') { started.set(`${e.bootId}|${e.sessionId}`, e); continue; }
    if (e.event === 'process_terminal') { terminal.set(`${e.bootId}|${e.sessionId}`, e); continue; }
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
}
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
  lifecycleJoin: 'Exact (bootId, sessionId) only. Historical receipt/log boot mismatches remain legacy; never merge boots automatically.',
  durationNote: 'Cumulative measured execution durations can overlap. They are neither wall-clock delay nor time wasted. Failure axes can overlap; failed counts each terminal execution once.',
  note: 'Metadata observations only, not task authority. Missing terminal events may mean running work, crash, log retention, or observation loss; never automatically retry. Legacy requests have no lifecycle coverage.',
};
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), hours, period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() }, samples, excludedProbes, malformed, executions, note: 'Retained rolling window only; marked probes excluded (historical marks may be spoofed). Overhead is per-request duration minus tool time, not a difference of percentiles. Sparse samples and different commands are not comparable performance proof. Tool time includes deliberate execution waits.', groups: [...groups.values()].map(g => ({ buildId:g.buildId, clientClass:g.clientClass, call:g.call, count:g.count, errors:g.errors, httpFailures:g.httpFailures, toolErrors:g.toolErrors, toolSucceeded:g.toolSucceeded, toolUnobserved:g.toolUnobserved, aborted:g.aborted, p50Ms:percentile(g.duration,.5), p95Ms:percentile(g.duration,.95), setupP95Ms:percentile(g.setup,.95), overheadP95Ms:percentile(g.overhead,.95), toolP95Ms:percentile(g.tool,.95), responseBytesP95:percentile(g.bytes,.95) })).sort((a,b)=>b.count-a.count) }, null, 2));
