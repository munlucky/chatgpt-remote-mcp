import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/src/config.js';
import { createServices } from '../dist/src/mcp-server.js';
import { startHttpServer } from '../dist/src/http-server.js';

const sampleCount = Number(process.env.MCP_BENCHMARK_SAMPLES || 3);
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > 30) throw new Error('Samples must be 1..30');
const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-control-benchmark-'));
const since = new Date().toISOString();
const source = await Promise.all(['exec-tools','process-manager','telemetry'].map(n => readFile(new URL(`../dist/src/${n}.js`, import.meta.url))));
const buildId = `bench-${createHash('sha256').update(Buffer.concat(source)).digest('hex').slice(0,16)}`;
const config = loadConfig({ MCP_AUTH_TOKEN: randomUUID(), MCP_DEFAULT_CWD: root, MCP_BUILD_ID: buildId,
  MCP_CONTINUITY_STATE_DIR: path.join(root,'state'), MCP_USAGE_LOG_DIR: path.join(root,'usage') }, root);
config.port = 0; config.host = '127.0.0.1'; config.buildId = buildId;
const services = createServices(config), server = await startHttpServer(config, services);
const endpoint = `http://127.0.0.1:${server.httpServer.address().port}`;
const latencies = [];
const call = async (name, args) => {
  const start = performance.now();
  const response = await fetch(`${endpoint}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${config.authToken}`,
    'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await response.json(); latencies.push(performance.now()-start);
  if (body.error || body.result?.isError) throw new Error(`Benchmark tool failed: ${name}`);
  return body.result.structuredContent;
};
const modes = process.argv.includes('--terminal') ? ['output','terminal'] : ['output'];
const rows = [];
try {
  const task = await call('checkpoint_work', { mode: 'create', cwd: root, requestId: randomUUID(), objective: 'Fixed synthetic execution benchmark',
    checkpoint: { phase: 'benchmark', current: 'measure', completed: [], remaining: [], blockers: [], evidenceRefs: [], changedPaths: [] } });
  for (const yieldTimeMs of [750,3000,5000]) for (const waitMode of modes) {
    const row = { yieldTimeMs, waitMode, executions: 0, polls: 0, automaticContextGuidance: 0, duplicateExtraSpawns: 0,
      responseLatenciesMs: [], outputBytes: 0, retentionLossBytes: 0 };
    for (const delayMs of [100,1100]) for (let sample = 0; sample < sampleCount; sample++) {
      const operationId = randomUUID(), offset = latencies.length;
      const args = { taskId: task.taskId, operationId, runtime: 'node', script: `console.log('start');setTimeout(()=>console.log('end'),${delayMs})`, yieldTimeMs };
      let result = await call('run_script', args); row.executions++;
      row.outputBytes += Buffer.byteLength((result.stdout || '') + (result.stderr || ''));
      while (result.running || result.hasMore) {
        result = await call('read_process', { sessionId: result.sessionId, afterSeq: result.nextSeq, waitMs: 1000, waitMode });
        row.polls++; row.outputBytes += Buffer.byteLength((result.stdout || '') + (result.stderr || ''));
      }
      if (result.nextCall?.tool === 'get_work_context') row.automaticContextGuidance++;
      row.retentionLossBytes += result.droppedOutputBytes;
      const replay = await call('run_script', args);
      if (replay.sessionId !== result.sessionId || replay.duplicate !== true) row.duplicateExtraSpawns++;
      row.responseLatenciesMs.push(...latencies.slice(offset));
    }
    rows.push(row);
  }
  const diagnostics = await (await fetch(`${endpoint}/diagnostics`, { headers: { authorization: `Bearer ${config.authToken}` } })).json();
  await services.usageLog.flush();
  const events = (await readFile(path.join(root,'usage','requests.jsonl'),'utf8')).trim().split('\n').map(s => JSON.parse(s));
  const starts = events.filter(e => e.event === 'process_started');
  const terminals = events.filter(e => e.event === 'process_terminal');
  const percentile = (xs,p) => [...xs].sort((a,b)=>a-b)[Math.ceil(xs.length*p)-1];
  console.log(JSON.stringify({ schemaVersion: 1, buildId, since, until: new Date().toISOString(), sampleCountPerDuration: sampleCount,
    workload: { delaysMs: [100,1100], output: 'two small lines, fits one response', parallelism: 1, pollWaitMs: 1000 },
    telemetry: { starts: starts.length, terminals: terminals.length,
      correlatedStarts: starts.filter(e => e.correlation?.taskId === task.taskId && e.correlation?.operationId && e.correlation?.workspaceId).length,
      droppedEvents: services.usageLog.droppedEvents, writeFailures: services.usageLog.writeFailures },
    peakActiveMcpRequests: diagnostics.peakActiveMcpRequests,
    rows: rows.map(({ responseLatenciesMs, ...row }) => ({ ...row, responseP50Ms: percentile(responseLatenciesMs,.5), responseP95Ms: percentile(responseLatenciesMs,.95) })),
    note: 'Synthetic sequential workload. Settings differ intentionally. Response latency includes deliberate waits; production performance is not inferred.' },null,2));
} finally { await server.close(); await rm(root, { recursive: true, force: true }); }
