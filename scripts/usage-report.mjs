import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
const dir = process.argv[2] || '/var/log/mcp-usage';
const hours = Number(process.argv[3] || 24);
if (!Number.isFinite(hours) || hours <= 0) throw new Error('hours must be positive');
const since = Date.now() - hours * 3600000;
const groups = new Map(); let malformed = 0; let samples = 0; let excludedProbes = 0;
for (const file of (await readdir(dir)).filter(f => /^requests\.jsonl(?:\.\d+)?$/.test(f))) {
  const reader = createInterface({ input: createReadStream(path.join(dir,file)), crlfDelay: Infinity });
  for await (const line of reader) {
    let e; try { e = JSON.parse(line); } catch { malformed++; continue; }
    if (e.event !== 'mcp_request' || !(Date.parse(e.timestamp) >= since)) continue;
    if (e.trafficClass === 'probe') { excludedProbes++; continue; }
    if (!Number.isFinite(e.durationMs)) { malformed++; continue; }
    const key = `${e.buildId}|${e.toolName || e.rpcMethod || 'http'}`;
    if (!groups.has(key)) groups.set(key, { buildId: e.buildId, call: e.toolName || e.rpcMethod || 'http', count: 0, errors: 0, aborted: 0, duration: [], overhead: [], setup: [], tool: [], bytes: [] });
    const g = groups.get(key); g.count++; samples++;
    if (Number.isFinite(e.toolMs)) g.overhead.push(Math.max(0,e.durationMs-e.toolMs));
    if (e.status >= 400 || e.toolError === true) g.errors++;
    if (e.outcome === 'aborted') g.aborted++;
    for (const [field,value] of [['duration',e.durationMs],['setup',e.setupMs],['tool',e.toolMs],['bytes',e.responseBytes]]) if (Number.isFinite(value)) g[field].push(value);
  }
}
const percentile = (values,p) => values.length ? +[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)].toFixed(2) : null;
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), hours, samples, excludedProbes, malformed, note: 'Retained rolling window only; marked probes excluded (historical marks may be spoofed). Overhead is per-request duration minus tool time, not a difference of percentiles. Sparse samples and different commands are not comparable performance proof. Tool time includes deliberate execution waits.', groups: [...groups.values()].map(g => ({ buildId:g.buildId, call:g.call, count:g.count, errors:g.errors, aborted:g.aborted, p50Ms:percentile(g.duration,.5), p95Ms:percentile(g.duration,.95), setupP95Ms:percentile(g.setup,.95), overheadP95Ms:percentile(g.overhead,.95), toolP95Ms:percentile(g.tool,.95), responseBytesP95:percentile(g.bytes,.95) })).sort((a,b)=>b.count-a.count) }, null, 2));
