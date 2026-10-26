import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("preserves ten safe error classifications, legacy gaps and fixed continuity metrics without writing inputs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-report-codes-"));
  const timestamp = "2026-10-25T01:00:00Z";
  const request = { event:"mcp_request", timestamp, buildId:"fixture", toolName:"read_process", durationMs:10, status:200, toolError:true };
  const file = path.join(root,"requests.jsonl");
  const secret = "sentinel-secret-command-token-path";
  try {
    const events = Array.from({length:10},(_,i)=>({ ...request,
      errorCode:i<7?"process_session_unknown":i<9?"patch_check_failed":"replacement_mismatch",
      errorCategory:"tool_failure", continuity:{receiptReads:20,syncCalls:4,gitMs:3,[secret]:1},
      processRead:{running:false,hasMore:false,waitMode:"terminal",requestedWaitMs:30000,effectiveWaitMs:0,drainOnly:true,requestedAfterSeq:i,nextSeq:i+1,responseElapsedMs:5000,responseBudgetMs:5000,responseDeadlineExceeded:true,persistenceVerification:i<7?"pending":"verified",persistenceState:"ok",command:secret}, message:secret }));
    await writeFile(file,events.map(e=>JSON.stringify(e)).join("\n")+"\n");
    const before = await readFile(file,"utf8");
    const report = JSON.parse(execFileSync(process.execPath,["scripts/usage-report.mjs",root,"--since","2026-10-25T00:00:00Z","--until","2026-10-26T00:00:00Z","--build-id","fixture"],{encoding:"utf8"}));
    expect(report.errorDistribution).toEqual({denominator:10,codes:{process_session_unknown:7,patch_check_failed:2,replacement_mismatch:1},categories:{tool_failure:10}});
    expect(report.continuity.receiptReads).toMatchObject({samples:10,unobserved:0,total:200,p95:20});
    expect(report.groups[0].errorCodes).toEqual(report.errorDistribution.codes);
    expect(report.polling.metadata.persistenceVerification).toEqual({denominator:10,unobserved:0,values:{pending:7,verified:3}});
    expect(report.polling.metadata.persistenceState.values).toEqual({ok:10});
    expect(report.polling.cursor).toEqual({observed:10,zeroWait:10});
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(await readFile(file,"utf8")).toBe(before);
    await writeFile(file,[{...request},{...request,errorCode:secret,errorCategory:secret}].map(e=>JSON.stringify(e)).join("\n")+"\n");
    const legacy = JSON.parse(execFileSync(process.execPath,["scripts/usage-report.mjs",root,"--since","2026-10-25T00:00:00Z","--until","2026-10-26T00:00:00Z"],{encoding:"utf8"}));
    expect(legacy.errorDistribution.codes).toEqual({other:1,unknown_code:1});
    expect(legacy.continuity.receiptReads).toMatchObject({samples:0,unobserved:2,total:null});
    expect(legacy.polling.metadata.persistenceVerification).toMatchObject({unobserved:2,values:{}});
    expect(JSON.stringify(legacy)).not.toContain(secret);
    await writeFile(file,JSON.stringify({...request,toolName:secret,clientClass:secret,outcome:secret,signal:secret,correlation:{taskId:secret,operationId:secret,workspaceId:secret},processRead:{waitMode:secret,persistenceVerification:secret,persistenceState:secret},environment:{TOKEN:secret},path:secret})+"\n");
    const injected=JSON.parse(execFileSync(process.execPath,["scripts/usage-report.mjs",root,"--since","2026-10-25T00:00:00Z","--until","2026-10-26T00:00:00Z"],{encoding:"utf8"}));
    expect(JSON.stringify(injected)).not.toContain(secret);
  } finally { await rm(root,{recursive:true,force:true}); }
});

it("separates failure axes, timeout policy and cumulative duration without double counting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-report-fixture-"));
  const timestamp = "2026-10-09T01:00:00Z";
  const base = { event: "process_terminal", timestamp, startedAt: "2026-10-09T00:59:59Z", endedAt: timestamp, bootId: "synthetic", timedOut: false, spawnFailed: false, signal: null };
  const req = { event: "mcp_request", timestamp, toolName: "read_file", durationMs: 10, toolMs: 2, status: 200 };
  try {
    await writeFile(path.join(root, "requests.jsonl"), [
      { ...base, sessionId: "timeout", timeoutMs: 1000, exitCode: 143, signal: "SIGTERM", timedOut: true },
      { ...base, sessionId: "success", timeoutMs: 0, exitCode: 0 },
      { ...base, sessionId: "legacy", exitCode: 7 },
      { ...base, sessionId: "spawn", timeoutMs: 0, exitCode: null, spawnFailed: true },
      { ...base, sessionId: "unknown", exitCode: null, startedAt: undefined },
      { ...base, sessionId: "probe", trafficClass: "probe", exitCode: 9 },
      { ...base, sessionId: "boundary", timestamp: "2026-10-10T00:00:00Z", exitCode: 9 },
      { ...req, toolError: true, status: 400 }, { ...req, toolError: null },
    ].map(e => JSON.stringify(e)).join("\n"));
    const report = JSON.parse(execFileSync(process.execPath, ["scripts/usage-report.mjs", root,
      "--since", "2026-10-09T00:00:00Z", "--until", "2026-10-10T00:00:00Z"], { encoding: "utf8" }));
    expect(report).toMatchObject({ samples: 2, excludedProbes: 1, executions: {
      terminal: 5, failed: 3, succeeded: 1, unknownOutcome: 1, timedOut: 1, nonzeroExit: 2, signaled: 1, spawnFailed: 1,
      timeoutLimits: [
        { timeoutMs: 0, policy: "unlimited", terminal: 2, cumulativeExecutionMs: 2000 },
        { timeoutMs: 1000, policy: "limited", terminal: 1, timedOut: 1, failed: 1, cumulativeExecutionMs: 1000 },
        { timeoutMs: null, policy: "unknown", terminal: 2, measuredDurations: 1, cumulativeExecutionMs: 1000 },
      ], successfulExecutionDuration: { samples: 1, cumulativeExecutionMs: 1000 },
    } });
    expect(report.groups[0]).toMatchObject({ errors: 1, httpFailures: 1, toolErrors: 1, toolSucceeded: 0, toolUnobserved: 1, overheadP95Ms: 8 });
    expect(JSON.stringify(report)).not.toMatch(/improvementRate|improvementPercent|speedup/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
