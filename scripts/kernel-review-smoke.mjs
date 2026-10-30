// Opt-in POSIX real-inference check. All faults affect a disposable project.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../dist/src/config.js';
import { createMcpServer, createServices } from '../dist/src/mcp-server.js';

if (process.platform === 'win32') throw new Error('This disposable fault-injection smoke currently requires POSIX; Windows live verification is separate.');
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const appCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
const codex = arg('--codex') || process.env.MCP_KERNEL_REVIEW_CODEX || (process.platform === 'darwin' && existsSync(appCodex) ? appCodex : 'codex');
const installed = await realpath(process.env.MOON_RELAY_KERNEL_HOME || path.join(os.homedir(), '.moon-relay-kernel'));
const payload = path.join(installed, '.moon-relay/kernel-payload');
const { createKernelControlPlane } = await import(pathToFileURL(path.join(payload, 'scripts/host/kernel/control-plane-runtime.js')).href);
const { openKernelStateStore } = await import(pathToFileURL(path.join(payload, 'scripts/kernel/state-store.js')).href);
const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'moonremote-kernel-review-smoke-')));
const project = path.join(root, 'project'), runtime = path.join(root, 'kernel');
await mkdir(path.join(project, '.moon-relay'), { recursive: true });
await mkdir(path.join(runtime, '.moon-relay'), { recursive: true });
await symlink(payload, path.join(runtime, '.moon-relay/kernel-payload'), 'dir');
await writeFile(path.join(project, '.moon-relay/track.yaml'), 'track: kernel\n');
await writeFile(path.join(project, 'package.json'), JSON.stringify({ type: 'module', scripts: { build: 'node --check app.mjs', test: 'node --test check.test.mjs' } }));
const safe = 'export const allowed = value => value === "approved";\n';
const bad = 'export const allowed = () => true;\n';
const positiveTest = 'import assert from "node:assert/strict"; import {allowed} from "./app.mjs"; assert.equal(allowed("approved"),true);\n';
const completeTest = positiveTest + 'assert.equal(allowed("other"),false);\n';
await writeFile(path.join(project, 'app.mjs'), 'export const allowed = () => false;\n');
await writeFile(path.join(project, 'check.test.mjs'), positiveTest);
const runId = `run-${randomUUID()}`;
const env = { ...process.env, MOON_RELAY_KERNEL_SESSION_ID: `smoke-owner-${randomUUID()}`, MOON_RELAY_KERNEL_PROVIDER: 'moonremote' };
const openCp = () => createKernelControlPlane({ runtimeHome: runtime, projectRoot: project, env, requireHostBinding: false });
async function mutateAndProve(title, source, test) {
  const cp = await openCp();
  try {
    await cp.ensureRun({ runId, objective: 'Restrict the guard to the literal approved value', taskContract: {
      acceptance: ['allowed must return true only for the exact string approved and false for all other inputs'],
      allowedPaths: ['app.mjs', 'check.test.mjs'], surfaces: ['security_boundary'],
      steps: [{ objective: title, acceptanceIds: ['AC-1'], allowedPaths: ['app.mjs', 'check.test.mjs'] }],
    } });
    const next = await cp.next(runId); assert.ok(next.stepId);
    const changed = [];
    for (const [name, content] of [['app.mjs', source], ['check.test.mjs', test]]) {
      if (await readFile(path.join(project, name), 'utf8') !== content) { await writeFile(path.join(project, name), content); changed.push(name); }
    }
    assert.ok(changed.length);
    const report = await cp.report(runId, { stepId: next.stepId, changedPaths: changed, summary: title,
      verifications: next.requiredVerifications.filter(v => v.evidenceClass === 'hard').map(v => ({ obligationId: v.obligationId, commandRef: v.allowedCommandRefs[0], acceptanceCoverage: ['AC-1'] })) });
    assert.deepEqual(report.failures, []);
    assert.equal(report.next.workAuthority.progress.remainingCount, 0);
  } finally { await cp.close(); }
}
async function receipts() { const cp = await openCp(); try { return cp.listReviewReceipts(runId); } finally { await cp.close(); } }
async function lastChain() {
  const store = await openKernelStateStore({ runtimeHome: runtime });
  try {
    const usage = store.listModelUsageReceipts(runId).at(-1);
    const capsule = usage?.capsuleId ? store.getExecutionCapsule(usage.capsuleId, { runId }) : null;
    const route = usage?.decisionId ? store.getModelRouteDecision(usage.decisionId, { runId }) : null;
    assert.equal(capsule?.role, 'reviewer'); assert.equal(route?.role, 'reviewer');
    return { capsuleId: capsule.capsuleId, routeDecisionId: route.decisionId, usageReceiptId: usage.receiptId };
  } finally { store.close(); }
}
async function faultExecutable(kind) {
  const script = path.join(root, `codex-${kind}.mjs`), marker = path.join(root, `${kind}-injected`);
  // This trusted fixture interposes one field/event on a real app-server. The
  // MCP request cannot select a fault or supply a verdict/session/receipt.
  await writeFile(script, `#!/usr/bin/env node\nimport{spawn}from'node:child_process';import{createInterface}from'node:readline';import fs from'node:fs';
const child=spawn(${JSON.stringify(codex)},process.argv.slice(2),{stdio:'pipe'});const methods=new Map();let injected=false;
createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id!==undefined)methods.set(q.id,q.method);child.stdin.write(line+'\\n')});
process.stdin.on('end',()=>child.stdin.end());child.stderr.pipe(process.stderr);
createInterface({input:child.stdout}).on('line',line=>{const m=JSON.parse(line),method=methods.get(m.id);
 if(!injected&&${JSON.stringify(kind)}==='telemetry'&&method==='thread/start'&&m.result){delete m.result.reasoningEffort;injected=true;fs.writeFileSync(${JSON.stringify(marker)},'observed effort removed');}
 if(!injected&&${JSON.stringify(kind)}==='drift'&&method==='turn/start'&&m.result?.turn?.id){fs.appendFileSync(${JSON.stringify(path.join(project, 'app.mjs'))},'// injected DURING actual review\\n');injected=true;fs.writeFileSync(${JSON.stringify(marker)},'source changed after issued capsule and turn start');}
 process.stdout.write(JSON.stringify(m)+'\\n');});
process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));child.on('close',code=>process.exit(code??0));
`, { mode: 0o700 });
  await chmod(script, 0o700); return { script, marker };
}

await mutateAndProve('Initial guard implementation with an intentionally incomplete test', bad, positiveTest);
const config = loadConfig({ MCP_ALLOW_NO_AUTH: 'true', MCP_DEFAULT_CWD: project,
  MCP_KERNEL_REVIEW_ENABLED: 'true', MCP_KERNEL_REVIEW_TARGET: 'local', MCP_KERNEL_REVIEW_CODEX: codex,
  MOON_RELAY_KERNEL_HOME: runtime, MCP_CONTINUITY_STATE_DIR: path.join(root, 'tracking') }, project);
const services = createServices(config), server = createMcpServer(config, services);
const client = new Client({ name: 'moonremote-kernel-review-smoke', version: '1' });
const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); assert.notEqual(r.isError, true, JSON.stringify(r.structuredContent)); return r.structuredContent; };
const digest = async () => createHash('sha256').update(await readFile(path.join(project, 'app.mjs'))).digest('hex');
try {
  const preflight = await call('get_kernel_review_status', { cwd: project, probeModelTools: true }); assert.equal(preflight.modelToolsVerified, true, JSON.stringify(preflight));
  const task = await call('checkpoint_work', { mode: 'create', cwd: project, requestId: randomUUID(), objective: 'Disposable independent review',
    checkpoint: { phase: 'review', current: 'verify', completed: [], remaining: ['receipt'], blockers: [], changedPaths: [], evidenceRefs: [] } });
  async function reviewOnce(executable = codex, dedupe = false) {
    config.kernelReview.codexExecutable = executable;
    const request = { cwd: project, runId, taskId: task.taskId, operationId: randomUUID() };
    const start = await call('start_kernel_review', request);
    if (dedupe) { const duplicate = await call('start_kernel_review', request); assert.equal(duplicate.duplicate, true); assert.equal(duplicate.sessionId, start.sessionId); }
    let result, output = '', args = start.nextCall.arguments;
    do { result = await call('read_process', args); output += result.stdout || ''; args = result.nextCall?.arguments || args; }
    while (result.running || result.hasMore || result.persistenceVerification === 'pending');
    const review = JSON.parse(output); await writeFile(path.join(root, request.operationId + '.json'), JSON.stringify({ request, review, terminal: result }, null, 2));
    return review;
  }
  const initialDigest = await digest(), first = await reviewOnce(codex, true);
  assert.equal(first.status, 'receipt-recorded', JSON.stringify(first)); assert.equal(first.verdict, 'fail', JSON.stringify(first));
  assert.equal(await digest(), initialDigest);
  const original = (await receipts()).find(r => r.receiptId === first.reviewReceiptId); assert.ok(original);
  await mutateAndProve('Fix the failed guard review and add the negative assertion', safe, completeTest);

  const telemetryFault = await faultExecutable('telemetry'), missing = await reviewOnce(telemetryFault.script);
  assert.equal(missing.status, 'blocked', JSON.stringify(missing)); assert.equal(missing.reviewReceiptId, null);
  assert.ok(existsSync(telemetryFault.marker)); assert.equal((await receipts()).length, 1);
  const telemetryChain = await lastChain();

  const driftFault = await faultExecutable('drift'), drift = await reviewOnce(driftFault.script);
  assert.equal(drift.status, 'blocked', JSON.stringify(drift)); assert.equal(drift.reviewReceiptId, null);
  assert.ok(existsSync(driftFault.marker)); assert.equal((await receipts()).length, 1);
  assert.ok((await readFile(path.join(project, 'app.mjs'), 'utf8')).includes('DURING actual review'));
  const driftChain = await lastChain();

  await mutateAndProve('Restore the fixture after deliberate in-review drift and obtain fresh proof', safe, completeTest);
  const before = await digest(), final = await reviewOnce();
  assert.equal(final.status, 'receipt-recorded', JSON.stringify(final)); assert.equal(final.verdict, 'pass', JSON.stringify(final));
  assert.equal(await digest(), before);
  const all = await receipts(); assert.equal(all.length, 2);
  const passed = all.find(r => r.receiptId === final.reviewReceiptId), failed = all.find(r => r.receiptId === first.reviewReceiptId);
  assert.equal(failed.digest, original.digest); assert.equal(failed.verdict, 'fail');
  assert.ok(passed.subject.mutationRevision > failed.subject.mutationRevision);
  assert.notEqual(passed.reviewer.actorSessionId, passed.implementer.actorSessionId); assert.equal(passed.reviewer.enforcementStatus, 'enforced');
  const evidence = { status: 'passed', runId, failedReceiptId: failed.receiptId, failedReceiptDigest: failed.digest,
    reviewReceiptId: passed.receiptId, receiptDigest: passed.digest, failedMutation: failed.subject.mutationRevision, reviewedMutation: passed.subject.mutationRevision,
    routeDecisionId: passed.reviewer.routeDecisionId, usageReceiptId: passed.reviewer.usageReceiptId,
    reviewerSessionHash: passed.reviewer.actorSessionId, implementationSessionHash: passed.implementer.actorSessionId,
    model: preflight.model, effort: preflight.effort, sourcePreservedAcrossReviews: true,
    telemetryFaultChain: telemetryChain, driftFaultChain: driftChain,
    checks: ['actual-model-tools', 'exact-operation-deduplication', 'kernel-official-failing-receipt', 'valid-chain-observed-effort-missing-blocked', 'actual-review-workspace-drift-blocked', 'fresh-hard-proof-after-fix', 'official-rereview-pass', 'failed-receipt-preserved'], runtime, project };
  await writeFile(path.join(root, 'result.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ ...evidence, artifact: path.join(root, 'result.json') }));
} finally { await client.close(); await server.close(); await services.continuityService.store.close(); }
