import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

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
