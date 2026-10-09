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
    if (!groups.has(key)) groups.set(key, { buildId: e.buildId, clientClass, call: e.toolName || e.rpcMethod || 'http', count: 0, errors: 0, aborted: 0, duration: [], overhead: [], setup: [], tool: [], bytes: [] });
    const g = groups.get(key); g.count++; samples++;
    if (Number.isFinite(e.toolMs)) g.overhead.push(Math.max(0,e.durationMs-e.toolMs));
    if (e.status >= 400 || e.toolError === true) g.errors++;
    if (e.outcome === 'aborted') g.aborted++;
    for (const [field,value] of [['duration',e.durationMs],['setup',e.setupMs],['tool',e.toolMs],['bytes',e.responseBytes]]) if (Number.isFinite(value)) g[field].push(value);
  }
}
const percentile = (values,p) => values.length ? +[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)].toFixed(2) : null;
const executions = {
  started: started.size,
  terminal: terminal.size,
  succeeded: [...terminal.values()].filter(e => e.exitCode === 0 && !e.timedOut && !e.spawnFailed && !e.signal).length,
  failed: [...terminal.values()].filter(e => e.exitCode !== 0 || e.timedOut || e.spawnFailed || e.signal).length,
  timedOut: [...terminal.values()].filter(e => e.timedOut).length,
  spawnFailed: [...terminal.values()].filter(e => e.spawnFailed).length,
  withoutTerminalInWindow: [...started.keys()].filter(key => !terminal.has(key)).length,
  note: 'Metadata observations only, not task authority. Missing terminal events may mean running work, crash, log retention, or observation loss; never automatically retry. Legacy requests have no lifecycle coverage.',
};
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), hours, period: { since: new Date(since).toISOString(), until: new Date(until).toISOString() }, samples, excludedProbes, malformed, executions, note: 'Retained rolling window only; marked probes excluded (historical marks may be spoofed). Overhead is per-request duration minus tool time, not a difference of percentiles. Sparse samples and different commands are not comparable performance proof. Tool time includes deliberate execution waits.', groups: [...groups.values()].map(g => ({ buildId:g.buildId, clientClass:g.clientClass, call:g.call, count:g.count, errors:g.errors, aborted:g.aborted, p50Ms:percentile(g.duration,.5), p95Ms:percentile(g.duration,.95), setupP95Ms:percentile(g.setup,.95), overheadP95Ms:percentile(g.overhead,.95), toolP95Ms:percentile(g.tool,.95), responseBytesP95:percentile(g.bytes,.95) })).sort((a,b)=>b.count-a.count) }, null, 2));
