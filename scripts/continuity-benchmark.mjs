// Isolated, deterministic workload. Never opens production continuity state.
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../dist/src/config.js';
import { createServices } from '../dist/src/mcp-server.js';
import { requestMetrics } from '../dist/src/telemetry.js';

const samples = Number(process.env.MCP_BENCHMARK_SAMPLES || 20);
const counts = (process.env.MCP_BENCHMARK_RECEIPTS || '100,1000,10000').split(',').map(Number);
if (!Number.isSafeInteger(samples) || samples < 1 || samples > 100
  || counts.some(n => !Number.isSafeInteger(n) || n < 1 || n > 10000)) throw new Error('Invalid benchmark size');
const fixture = { targetReceipts: 10, unrelatedReceipts: counts, samples, concurrency: 1, format: 'summary', recentLimit: 10,
  process: { waitMode: 'output', waitMs: 1000, maxOutputBytes: 65536, spawned: 0, generatedBytes: 0, returnedBytes: 0, droppedBytes: 0, aborted: 0 } };
const fixtureDigest = createHash('sha256').update(JSON.stringify(fixture)).digest('hex');
const buildId = execFileSync(process.execPath, ['scripts/build-id.mjs'], { encoding: 'utf8' }).trim();
const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1];
const rows = [];
for (const unrelated of counts) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcp-context-benchmark-'));
  const workspace = path.join(root,'workspace');
  await mkdir(workspace);
  execFileSync('git',['init','--quiet',workspace]);
  const config = loadConfig({ MCP_AUTH_TOKEN: randomUUID(), MCP_DEFAULT_CWD: workspace,
    MCP_CONTINUITY_STATE_DIR: path.join(root,'state'), MCP_CONTINUITY_MAX_TOTAL_BYTES: String(256*1024*1024) }, workspace);
  let services = createServices(config);
  const checkpoint = { phase:'benchmark',current:'measure',completed:[],remaining:[],blockers:[],changedPaths:[],evidenceRefs:[] };
  try {
    const target = await services.continuityService.create({ cwd:workspace, requestId:randomUUID(), objective:'target fixture', checkpoint });
    const identity = await services.continuityService.workspaceIdentity.resolve(workspace);
    const prepared = await services.executionRecorder.prepare({ cwd:workspace, taskId:target.taskId, operationId:randomUUID(), toolKind:'run_script', semanticInput:{fixture:true} });
    await services.executionRecorder.markSpawnFailed(prepared.record);
    const directory = path.join(root,'state','workspaces',identity.workspaceId);
    const stateFile = path.join(directory,'state.json');
    await services.continuityService.close();
    const state = JSON.parse(await readFile(stateFile,'utf8'));
    const otherId = randomUUID();
    state.tasks[otherId] = { ...state.tasks[target.taskId], taskId:otherId, objective:'unrelated fixture', status:'completed', completedAt:new Date().toISOString() };
    await writeFile(stateFile,JSON.stringify(state));
    const terminal = JSON.parse(await readFile(path.join(directory,'executions',`${prepared.record.operationId}.json`),'utf8'));
    for (let i=1;i<unrelated+10;i++) {
      const operationId = `00000000-0000-4000-8000-${i.toString(16).padStart(12,'0')}`;
      await writeFile(path.join(directory,'executions',`${operationId}.json`),JSON.stringify({ ...terminal,operationId,taskId:i<10?target.taskId:otherId }));
    }
    services = createServices(config);
    const startupStarted = performance.now();
    await services.continuityService.initialize();
    const startupMs = performance.now()-startupStarted;
    const measurements = [];
    for(let i=0;i<samples+1;i++) {
      const metrics = { setupMs:null,toolMs:null,toolError:null };
      const started=performance.now();
      const result=await requestMetrics.run(metrics,()=>services.continuityService.context({taskId:target.taskId,format:'summary',recentExecutionLimit:10}));
      if(result.executions.total!==10) throw new Error('Fixture target count mismatch');
      measurements.push({elapsedMs:performance.now()-started,...metrics.continuity});
    }
    const [first,...warm]=measurements;
    const metrics=Object.fromEntries([...new Set(warm.flatMap(row=>Object.keys(row)))].map(key=>{
      const values=warm.map(row=>row[key]).filter(Number.isFinite);
      return [key,{samples:values.length,p50:percentile(values,.5),p95:percentile(values,.95)}];
    }));
    rows.push({unrelatedReceipts:unrelated,startupMs,first,warm:metrics});
    console.error(JSON.stringify({completedUnrelatedReceipts:unrelated,p95Ms:metrics.elapsedMs.p95,receiptReads:metrics.receiptReads.p95,syncCalls:metrics.syncCalls.p95}));
  } finally {
    await services.processManager.shutdown();
    await services.continuityService.close();
    await rm(root,{recursive:true,force:true});
  }
}
console.log(JSON.stringify({schemaVersion:1,buildId,fixtureDigest,fixture,environment:{platform:process.platform,node:process.version},rows,
  note:'Synthetic isolated workspace. First call and startup excluded from warm p50/p95. Timings overlap: task lookup includes storage work. No production performance claim.'},null,2));
