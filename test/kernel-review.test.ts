import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkReviewReadAccess, executeReview, initializeReviewRpc, prepareReviewSession, ReviewRpc } from "../src/kernel-review-rpc.js";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { KernelReviewService } from "../src/kernel-review.js";
import { canRereviewFixedJudgment, formatKernelReviewResult } from "../src/kernel-review-runtime.js";
import { finalizeObservedReview, ReviewBudget, ReviewOutcomeJournal } from "../src/kernel-review-lifecycle.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function root() { const dir = await mkdtemp(path.join(os.tmpdir(), "kernel-review-test-")); roots.push(dir); return dir; }
const fakeServer = `
import readline from 'node:readline';import fs from 'node:fs';
const scenario=process.argv[2],log=process.argv[3];
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
 const q=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(q)+'\\n');
 if(q.id===undefined)return;
 let result={};
 if(q.method==='initialize')result={userAgent:'fixture'};
 if(q.method==='account/read')result={account:scenario==='unauth'?null:{type:'fixture'}};
 if(q.method==='command/exec')result={exitCode:scenario==='no-read'?1:0,stdout:q.params.cwd,stderr:''};
 if(q.method==='config/read')result={config:{mcp_servers:{danger:{command:'write'}},plugins:{external:{enabled:true}}}};
 if(q.method==='thread/start')result={thread:{id:'fresh-session',ephemeral:true},model:scenario==='model'?'wrong':q.params.model,
 reasoningEffort:q.params.config.model_reasoning_effort,cwd:q.params.cwd,approvalPolicy:'never',sandbox:{type:scenario==='writable'?'dangerFullAccess':'readOnly'}};
 if(q.method==='turn/start'){
   result={turn:{id:'turn-1',status:'inProgress'}};send({id:q.id,result});
   if(scenario==='disconnect'){process.exit(2);return;}
   if(scenario==='request'){send({id:999,method:'item/tool/call',params:{}});return;}
   if(scenario==='timeout')return;
   if(scenario!=='no-command')send({method:'item/completed',params:{threadId:'fresh-session',turnId:'turn-1',item:{type:'commandExecution',status:'completed',exitCode:0}}});
   send({method:'item/completed',params:{threadId:'fresh-session',turnId:'turn-1',item:{type:'agentMessage',text:JSON.stringify({verdict:'pass',findings:[],risks:[],evidenceRefs:['app.ts:1']})}}});
   send({method:'turn/completed',params:{threadId:'fresh-session',turn:{id:'turn-1',status:scenario==='failed'?'failed':'completed',items:[]}}});return;
 }
 send({id:q.id,result});
});
`;
async function rpc(scenario = "pass") {
  const dir = await root(); const script = path.join(dir, "server.mjs"); const log = path.join(dir, "rpc.jsonl");
  await writeFile(script, fakeServer);
  return { rpc: new ReviewRpc(process.execPath, [script, scenario, log], dir), dir, log };
}
const input = (cwd: string) => ({ model: "host-model", effort: "xhigh", cwd, message: "Kernel-issued capsule", outputSchema: {} });

describe("independent reviewer protocol", () => {
  it("checks actual sandboxed directory access before declaring the reviewer ready", async () => {
    const f = await rpc("no-read");
    try { await initializeReviewRpc(f.rpc); await expect(checkReviewReadAccess(f.rpc, f.dir)).rejects.toThrow("read_access_unavailable"); }
    finally { await f.rpc.close(); }
  });
  it("uses a fresh read-only session, disables inherited external capabilities and accepts only a completed turn", async () => {
    const f = await rpc();
    try {
      await initializeReviewRpc(f.rpc);
      const result = await executeReview(f.rpc, input(f.dir), new AbortController().signal);
      expect(result).toMatchObject({ sessionId: "fresh-session", model: "host-model", effort: "xhigh", outcome: { verdict: "pass" } });
      expect(result.successfulCommands).toBe(1);
      const calls = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      const thread = calls.find(call => call.method === "thread/start").params;
      expect(thread).toMatchObject({ ephemeral: true, allowProviderModelFallback: false, sandbox: "read-only", approvalPolicy: "never",
        config: { mcp_servers: { danger: { enabled: false } }, plugins: { external: { enabled: false } }, agents: { max_threads: 1 } } });
      expect(calls.find(call => call.method === "turn/start").params.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
    } finally { expect(await f.rpc.close()).toBe(true); }
  });
  it("does not count a model-only claim as observed filesystem tool access", async () => {
    const f = await rpc("no-command");
    try {
      await initializeReviewRpc(f.rpc);
      const result = await executeReview(f.rpc, input(f.dir), new AbortController().signal);
      expect(result.outcome.verdict).toBe("pass"); expect(result.successfulCommands).toBe(0);
    } finally { await f.rpc.close(); }
  });
  it.each(["model", "writable"])("rejects %s configuration before inference", async scenario => {
    const f = await rpc(scenario);
    try {
      await initializeReviewRpc(f.rpc);
      await expect(prepareReviewSession(f.rpc, input(f.dir))).rejects.toThrow("configuration_mismatch");
      expect(await readFile(f.log, "utf8")).not.toContain('"method":"turn/start"');
    } finally { await f.rpc.close(); }
  });
  it.each(["request", "disconnect", "failed"])("never turns %s into a review pass", async scenario => {
    const f = await rpc(scenario);
    try { await initializeReviewRpc(f.rpc); await expect(executeReview(f.rpc, input(f.dir), new AbortController().signal)).rejects.toThrow(); }
    finally { await f.rpc.close(); }
  });
  it("rejects unauthenticated sessions and a timed out turn", async () => {
    const unauth = await rpc("unauth");
    try { await expect(initializeReviewRpc(unauth.rpc)).rejects.toThrow("not_authenticated"); } finally { await unauth.rpc.close(); }
    const f = await rpc("timeout"); const controller = new AbortController();
    try {
      await initializeReviewRpc(f.rpc);
      const result = executeReview(f.rpc, input(f.dir), controller.signal);
      const timer = setTimeout(() => controller.abort(), 100);
      await expect(result).rejects.toThrow("timeout_or_cancelled"); clearTimeout(timer);
    } finally { await f.rpc.close(); }
  });
});

describe("review execution tracking", () => {
  it("permits official re-review only for a changed implementation with all fresh hard proof", () => {
    const input = { action: { type: "fix" }, verification: { failed: [{ obligationId: "security-review" }] },
      workAuthority: { progress: { remainingCount: 0 } }, trustAuthority: { requirements: [{ evidenceClass: "hard", satisfied: true, evidenceStatus: "fresh" }], decision: { gates: { mutationProvenanceCurrent: true } } } };
    const receipt = { obligationId: "security-review", verdict: "fail", subject: { mutationRevision: 1 } };
    expect(canRereviewFixedJudgment(input, receipt, 2)).toBe(true);
    expect(canRereviewFixedJudgment(input, receipt, 1)).toBe(false);
    expect(canRereviewFixedJudgment({ ...input, workAuthority: { progress: { remainingCount: 1 } } }, receipt, 2)).toBe(false);
    expect(canRereviewFixedJudgment({ ...input, trustAuthority: { requirements: [{ evidenceClass: "hard", satisfied: false, evidenceStatus: "stale" }] } }, receipt, 2)).toBe(false);
    expect(canRereviewFixedJudgment({ ...input, verification: { failed: [{ obligationId: "unit-test" }] } }, receipt, 2)).toBe(false);
    expect(canRereviewFixedJudgment(input, { ...receipt, verdict: "pass" }, 2)).toBe(false);
  });
  it("settles delayed cleanup and fences ingestion when the deadline expires after a verdict", async () => {
    const budget = new ReviewBudget(10), journal = new ReviewOutcomeJournal(), ingest = vi.fn();
    const outcome = { verdict: "fail", findings: ["preserved"], evidenceRefs: ["app.ts:1"] };
    let settled = false;
    try {
      await expect((async () => {
        await finalizeObservedReview({ outcome }, journal, budget, async () => {
          await new Promise(resolve => setTimeout(resolve, 30)); settled = true; return true;
        });
        budget.beginCommit(); ingest();
      })()).rejects.toThrow("deadline_exceeded");
      expect(settled).toBe(true); expect(ingest).not.toHaveBeenCalled(); expect(journal.outcome).toEqual(outcome);
    } finally { budget.dispose(); }
  });
  it("preserves a verdict when cleanup throws and when receipt ingestion is rejected", async () => {
    const budget = new ReviewBudget(1000), journal = new ReviewOutcomeJournal();
    const outcome = { verdict: "blocked", findings: ["source evidence"], evidenceRefs: ["app.ts:1"], risks: [] };
    try {
      await expect(finalizeObservedReview({ outcome }, journal, budget, async () => { throw new Error("cleanup failed"); })).rejects.toThrow();
      expect(formatKernelReviewResult({ blocker: { reason: "ingestion-rejected" } }, "run-test", journal.outcome)).toMatchObject({ status: "blocked", reviewerOutcome: outcome, reviewReceiptId: null });
    } finally { budget.dispose(); }
  });
  it("awaits an already-started Kernel commit instead of reporting a timeout with late success", async () => {
    const budget = new ReviewBudget(10); let committed = false;
    try {
      budget.beginCommit();
      await new Promise(resolve => setTimeout(resolve, 30)); committed = true;
      expect(() => budget.check()).not.toThrow(); expect(committed).toBe(true);
    } finally { budget.dispose(); }
  });
  it("preserves a blocked reviewer explanation separately from Kernel ingestion rejection", () => {
    const outcome = { verdict: "blocked", findings: [], risks: ["source unavailable"], evidenceRefs: [] };
    expect(formatKernelReviewResult({ dispatch: { outcome }, review: { blockedReason: "incomplete_review_chain" } }, "run-test")).toMatchObject({
      status: "blocked", verdict: "blocked", reviewReceiptId: null, reviewerOutcome: outcome,
      blocker: { reason: "reviewer-blocked", risks: ["source unavailable"] }, kernelRejection: { reason: "incomplete_review_chain" },
    });
    expect(formatKernelReviewResult({ dispatch: { outcome: { ...outcome, verdict: "pass" } }, blocker: { reason: "stale" } }, "run-test")).toMatchObject({ status: "blocked", verdict: "pass", reviewReceiptId: null, blocker: { reason: "stale" } });
    expect(formatKernelReviewResult({ reason: "review-already-claimed", review: { review: { verdict: "pass", findings: [] } } }, "run-test")).toMatchObject({ status: "blocked", verdict: null, reviewerOutcome: null, reviewReceiptId: null });
  });
  it("validates opt-in target and deadline settings", () => {
    expect(loadConfig({ MCP_ALLOW_NO_AUTH: "true" }).kernelReview).toMatchObject({ enabled: false, target: "local", timeoutMs: 600000 });
    expect(() => loadConfig({ MCP_ALLOW_NO_AUTH: "true", MCP_KERNEL_REVIEW_TARGET: "guess" })).toThrow("TARGET");
    expect(() => loadConfig({ MCP_ALLOW_NO_AUTH: "true", MCP_KERNEL_REVIEW_TIMEOUT_MS: "1" })).toThrow("TIMEOUT");
  });
  it("reuses the exact operation without spawning another reviewer and rejects changed input", async () => {
    const dir = await root();
    const config = loadConfig({ MCP_ALLOW_NO_AUTH: "true", MCP_KERNEL_REVIEW_ENABLED: "true", MCP_CONTINUITY_STATE_DIR: path.join(dir, "state") }, dir);
    const services = createServices(config);
    const task = await services.continuityService.create({ cwd: dir, requestId: randomUUID(), objective: "review fixture",
      checkpoint: { phase: "review", current: "review", remaining: [], completed: [], blockers: [], changedPaths: [], evidenceRefs: [] } });
    const start = vi.spyOn(services.processManager, "start").mockReturnValue("managed-session");
    const review = new KernelReviewService(config, services.processManager, services.executionRecorder);
    const request = { cwd: dir, runId: "run-fixture", taskId: String(task.taskId), operationId: randomUUID() };
    try {
      expect(await review.start(request)).toMatchObject({ status: "accepted", sessionId: "managed-session" });
      expect(await review.start(request)).toMatchObject({ duplicate: true, sessionId: "managed-session" });
      expect(start).toHaveBeenCalledTimes(1);
      await expect(review.start({ ...request, runId: "run-other" })).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(review.start({ ...request, taskId: randomUUID(), operationId: randomUUID() })).rejects.toMatchObject({ code: "unknown_task" });
    } finally { await services.continuityService.store.close(); }
  });
  it("reports disabled before loading an optional Kernel or Codex dependency", async () => {
    const dir = await root(); const config = loadConfig({ MCP_ALLOW_NO_AUTH: "true" }, dir); const services = createServices(config);
    const review = new KernelReviewService(config, services.processManager, services.executionRecorder);
    expect(await review.status(dir)).toMatchObject({ status: "disabled", canExecuteReview: false });
  });
});
