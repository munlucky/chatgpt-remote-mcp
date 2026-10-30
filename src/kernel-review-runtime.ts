import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { assertHostExecutorAvailable, createHostExecutorJob, mapContainerPathToHost, type HostExecutorConfig } from "./host-executor.js";
import { checkReviewReadAccess, executeReview, initializeReviewRpc, prepareReviewSession, ReviewRpc } from "./kernel-review-rpc.js";
import { finalizeObservedReview, ReviewBudget, ReviewOutcomeJournal } from "./kernel-review-lifecycle.js";

export interface ReviewPlan {
  mode: "status" | "review";
  cwd: string;
  runId?: string;
  parentSessionId: string;
  kernelHome: string;
  codexExecutable: string;
  target: "local" | "host";
  hostExecutor: HostExecutorConfig;
  timeoutMs: number;
  probeModelTools?: boolean;
}

export function formatKernelReviewResult(result: any, runId: string, observedOutcome: unknown = null): Record<string, unknown> {
  const outcome = result.dispatch?.outcome ?? (result.reviewReceiptId ? result.review?.review : null) ?? observedOutcome;
  const kernelRejection = result.blocker ?? (result.review?.blockedReason
    ? { reason: result.review.blockedReason, detail: result.review.errorSummary ?? null } : null);
  return { status: result.reviewReceiptId ? "receipt-recorded" : "blocked", runId,
    reviewReceiptId: result.reviewReceiptId ?? null,
    verdict: outcome?.verdict ?? (result.reviewReceiptId ? result.hostReview?.verdict : null) ?? null,
    reviewerOutcome: outcome, review: result.hostReview ?? null,
    blocker: outcome?.verdict === "blocked" ? { reason: "reviewer-blocked", risks: outcome.risks ?? [], findings: outcome.findings ?? [] }
      : kernelRejection ?? result.hostReview?.blocker ?? result.reason ?? null,
    executionError: result.dispatch?.errorCode ? { reason: result.dispatch.errorCode, detail: result.dispatch.errorSummary ?? null } : null,
    kernelRejection };
}

export function canRereviewFixedJudgment(modelInput: any, receipt: any, mutationRevision: number): boolean {
  const failed = modelInput.verification?.failed ?? [];
  const hard = (modelInput.trustAuthority?.requirements ?? []).filter((entry: any) => entry.evidenceClass === "hard");
  return modelInput.action?.type === "fix" && failed.length === 1 && failed[0].obligationId === "security-review"
    && receipt?.obligationId === "security-review" && receipt.verdict === "fail"
    && Number.isInteger(receipt.subject?.mutationRevision) && receipt.subject.mutationRevision < mutationRevision
    && modelInput.workAuthority?.progress?.remainingCount === 0 && hard.length > 0
    && hard.every((entry: any) => entry.satisfied === true && entry.evidenceStatus === "fresh")
    && modelInput.trustAuthority?.decision?.gates?.mutationProvenanceCurrent === true;
}

// The Kernel remains the sole writer of usage/review receipts. Dynamic imports
// use the configured installed payload, never a caller-supplied module.
async function loadKernel(home: string) {
  const payload = path.join(home, ".moon-relay/kernel-payload/scripts");
  const load = (relative: string) => import(pathToFileURL(path.join(payload, relative)).href);
  const [control, bridge, transport, observer, schema, policy, dispatcher, registry] = await Promise.all([
    load("host/kernel/control-plane-runtime.js"), load("host/kernel/lifecycle-bridge.js"),
    load("host/kernel/independent-subagent-review.js"), load("host/kernel/workspace/workspace-identity.js"),
    load("host/kernel/adapters/codex.js"), load("host/kernel/codex-model-policy.js"),
    load("host/kernel/turn-dispatcher.js"), load("host/kernel/model-registry.js"),
  ]);
  return { ...control, ...bridge, ...transport, ...observer, ...schema, ...policy, ...dispatcher, ...registry };
}

async function openReviewer(plan: ReviewPlan) {
  let cleanup: (() => Promise<void>) | undefined;
  let jobDir: string | undefined;
  let rpc: ReviewRpc;
  let cwd = plan.cwd;
  if (plan.target === "host") {
    const host = await assertHostExecutorAvailable(plan.hostExecutor);
    cwd = mapContainerPathToHost(cwd, plan.hostExecutor.pathMappings);
    // Executable is operator configuration. Never interpolate a model prompt,
    // cwd, route, verdict, or tool input into shell text.
    const executable = host.platform === "win32"
      ? `& '${plan.codexExecutable.replaceAll("'", "''")}'`
      : `'${plan.codexExecutable.replaceAll("'", "'\\''")}'`;
    const job = await createHostExecutorJob(plan.hostExecutor, { command: `${executable} app-server --stdio`, cwd, login: true,
      env: { CODEX_APP_TOOLS_PIPE_PATH: "", CODEX_APP_RUNTIME_CLI_PATH: "", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CODEX_TOOL_CALL_ID: "", CODEX_PERMISSION_PROFILE: "" } });
    cleanup = job.cleanup;
    jobDir = job.jobDir;
    rpc = new ReviewRpc(process.execPath, [job.clientScript, job.jobDir], plan.cwd);
  } else rpc = new ReviewRpc(plan.codexExecutable, ["app-server", "--stdio"], plan.cwd);
  let closing: Promise<boolean> | undefined;
  return { rpc, cwd, close() { return closing ??= (async () => {
    let clean = await rpc.close();
    // A native client can exit before its remote child. Retain the queue if
    // termination is unconfirmed; it is evidence for inspection, not a replay.
    if (clean && jobDir) {
      try {
        const result = JSON.parse(await readFile(path.join(jobDir, "result.json"), "utf8"));
        clean = Boolean(result.endedAt && !result.error && (Number.isInteger(result.exitCode) || result.signal));
      } catch { clean = false; }
    }
    if (clean) await cleanup?.();
    return clean;
  })(); } };
}

export async function runKernelReview(plan: ReviewPlan): Promise<Record<string, unknown>> {
  const kernel = await loadKernel(plan.kernelHome);
  const reviewer = await openReviewer(plan);
  const budget = new ReviewBudget(plan.timeoutMs);
  const journal = new ReviewOutcomeJournal();
  const cancel = () => { void reviewer.close().catch(() => false); };
  budget.signal.addEventListener("abort", cancel, { once: true });
  let cp: any;
  const ownedClaims: any[] = [];
  let launcherFailure: Record<string, unknown> | null = null;
  let reviewerClosed = false;
  let response: Record<string, unknown>;
  const execute = async (): Promise<Record<string, unknown>> => {
    await budget.wait(() => initializeReviewRpc(reviewer.rpc));
    await budget.wait(() => checkReviewReadAccess(reviewer.rpc, reviewer.cwd));
    const route = kernel.resolveCodexModelPolicy({ executionClass: "review" });
    if (plan.mode === "status") {
      if (plan.probeModelTools) {
        const probe = await budget.wait(() => executeReview(reviewer.rpc, {
          model: route.model, effort: route.effort, cwd: reviewer.cwd,
          message: "Read-only runtime diagnostic. Use the execution tool to run pwd (or its Windows equivalent) in the repository. Return JSON {ok:true,cwd:<exact tool output>} only if it succeeded. If the tool failed return ok:false and its error as cwd. Do not inspect other files, change files, delegate, or invoke Kernel.",
          outputSchema: { type: "object", properties: { ok: { type: "boolean" }, cwd: { type: "string" } }, required: ["ok", "cwd"], additionalProperties: false },
        }, budget.signal));
        if (probe.successfulCommands < 1 || probe.outcome?.ok !== true || probe.outcome.cwd?.trim() !== reviewer.cwd) throw new Error("review_model_tool_access_unavailable");
      } else await budget.wait(() => prepareReviewSession(reviewer.rpc, { model: route.model, effort: route.effort, cwd: reviewer.cwd }));
      const clean = await budget.wait(() => reviewer.close()); reviewerClosed = true;
      if (!clean) throw new Error("reviewer_cleanup_unconfirmed");
      return { status: "ready", transport: "codex-app-server", target: plan.target,
        model: route.model, effort: route.effort, authenticated: true, readOnly: true, modelToolsVerified: plan.probeModelTools === true,
        note: plan.probeModelTools ? "A completed model turn and successful read-only tool execution were observed; this is not a security review verdict."
          : "Protocol, read-only session, and authentication are available. Use probeModelTools=true to test actual model/tool access before project mutations." };
    }
    if (!plan.runId) throw new Error("review_run_id_required");
    const rawCp: any = await kernel.createKernelControlPlane({ runtimeHome: plan.kernelHome, projectRoot: plan.cwd, requireHostBinding: false });
    // The sole irreversible handoff. No timeout can be reported while an
    // unobserved background ingestion continues against a closed control plane.
    cp = new Proxy(rawCp, { get(target: any, key) {
      if (key === "claimReviewAttempt") return (input: any) => {
        const result = target.claimReviewAttempt(input);
        if (result?.claimed === true) ownedClaims.push(input);
        return result;
      };
      if (key === "ingestReviewerOutcome") return async (...args: any[]) => {
        budget.beginCommit(); return await target.ingestReviewerOutcome(...args);
      };
      return Reflect.get(target, key);
    } });
    budget.check();
    const modelInput = await cp.next(plan.runId);
    const prior = cp.listReviewReceipts(plan.runId, { obligationId: "security-review" }).sort((a: any, b: any) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const currentRun = await cp.getRun(plan.runId);
    const rereview = canRereviewFixedJudgment(modelInput, prior, currentRun.mutationRevision);
    if (modelInput.action?.type !== "review" && !rereview) return { status: "blocked", reason: "kernel_review_action_required", action: modelInput.action?.type ?? null };
    const base = kernel.createIndependentSubagentReviewTransport({ spawnIndependentReviewer: async () => { throw new Error("dispatch_context_required"); } });
    const adapter = { ...base, async dispatch(input: any) {
      budget.check();
      const subject = input.reviewSubject;
      const observe = () => kernel.observeWorkspaceIdentity({ projectRoot: plan.cwd }).identity;
      const before = observe();
      const beforeRun = await cp.getRun(plan.runId);
      if (before !== subject?.workspaceIdentity || beforeRun.mutationRevision !== subject.mutationRevision) throw new Error("review_subject_changed_before_launch");
      const transport = kernel.createIndependentSubagentReviewTransport({ timeoutMs: plan.timeoutMs, spawnIndependentReviewer: async (request: any) => {
        try {
        const observed = await executeReview(reviewer.rpc, {
          model: request.model, effort: request.reasoningEffort, cwd: reviewer.cwd,
          message: `Host repository root: ${reviewer.cwd}\nKernel repository root: ${plan.cwd}\nThese identify the same mounted workspace. Resolve source references relative to the host repository root.\n\n${request.message}`,
          outputSchema: kernel.CODEX_REVIEW_OUTPUT_SCHEMA,
        }, budget.signal);
        const result = await finalizeObservedReview(observed, journal, budget, () => reviewer.close());
        reviewerClosed = true;
        const after = observe();
        const afterRun = await cp.getRun(plan.runId);
        budget.check();
        return { outcome: result.outcome, inputTokens: result.usage?.total?.inputTokens ?? null,
          outputTokens: result.usage?.total?.outputTokens ?? null,
          reasoningTokens: result.usage?.total?.reasoningOutputTokens ?? null, reviewTransportAttestation: {
          schemaVersion: 1, transport: "independent-subagent", executionId: randomUUID(),
          childSessionId: result.sessionId, parentSessionId: request.parentSessionId,
          requestedModel: request.model, requestedEffort: request.reasoningEffort,
          observedModel: result.model, observedEffort: result.effort,
          freshContext: true, readOnly: true, canCommit: false, canDelegate: false, cleanupStatus: "clean",
          workspaceIdentityBefore: before, workspaceIdentityAfter: after,
          mutationRevisionBefore: beforeRun.mutationRevision, mutationRevisionAfter: afterRun.mutationRevision,
          capsuleDigest: subject.capsuleDigest,
        } };
        } catch (error) {
          launcherFailure = { reason: (error as Error)?.message?.match(/^[a-z_]+$/)?.[0] ?? "review_launcher_failed", phase: "provider-or-cleanup" };
          // Resolve a failed launch rather than reject it. Some installed
          // transports retain their wait timer when the launch Promise rejects.
          // No outcome or attestation means the official path must fail closed.
          return { status: "failed", outcome: null, failureStage: "post-spawn" };
        }
      } });
      return transport.dispatch(input);
    } };
    const bridge = kernel.createKernelHostReviewBridge({ adapter, runtimeHome: plan.kernelHome, parentSessionId: plan.parentSessionId });
    const result = rereview
      ? await kernel.dispatchKernelTurn({ controlPlane: cp, runId: plan.runId, adapter, runtimeHome: plan.kernelHome,
          registry: kernel.createModelRegistry({ surface: "codex", runtimeHome: plan.kernelHome }), parentSessionId: plan.parentSessionId,
          actionContext: { actionKind: "review_engineering", obligationId: "security-review", executionMode: "native-subagent", delegationRequested: true, independentReviewRequired: true } })
      : await bridge.dispatchReview({ controlPlane: cp, runId: plan.runId, modelInput });
    const formatted = formatKernelReviewResult(result, plan.runId, journal.outcome);
    if (launcherFailure) formatted.executionError = launcherFailure;
    return formatted;
  };
  try { response = await execute(); }
  catch (error) {
    response = { status: "blocked", runId: plan.runId ?? null, reviewReceiptId: null,
      reviewerOutcome: journal.outcome, executionError: { reason: (error as Error)?.message?.match(/^[a-z_]+$/)?.[0] ?? "review_execution_failed" } };
  } finally {
    budget.dispose(); budget.signal.removeEventListener("abort", cancel);
    try { if (!reviewerClosed) await reviewer.close(); } catch { /* Retained job supplies recovery evidence. */ }
    // Installed dispatchers can return early without releasing a failed claim.
    // Release only claims this exact dispatch acquired, through Kernel's API,
    // after dispatch has settled. Never release another session's active claim.
    for (const claim of ownedClaims) {
      try { cp.releaseReviewClaim(claim.claimKey, claim.holder, { runId: claim.runId, stepId: claim.stepId, planRevision: claim.planRevision }); }
      catch { /* Unreleased authority remains visible and expires in Kernel. */ }
    }
    try { await cp?.close(); } catch { /* Ingestion has settled before close is attempted. */ }
  }
  return response;
}
