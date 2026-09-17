import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  FileFingerprint,
  WorkspaceIdentityRecord,
  WorkspaceObservation,
} from "./task-types.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceSnapshotLimits {
  maxFiles: number;
  maxBytes: number;
  maxDurationMs: number;
}

interface GitSnapshot {
  head: string | null;
  unborn: boolean;
  branch: string | null;
  detached: boolean;
  statusRaw: string;
  changed: Array<{ status: string; path: string }>;
}

async function git(cwd: string, args: string[], maxBuffer = 2 * 1024 * 1024): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

async function inspectGit(root: string): Promise<GitSnapshot> {
  let head: string | null = null;
  let unborn = false;
  try {
    head = (await git(root, ["rev-parse", "HEAD"])).trim() || null;
  } catch {
    unborn = true;
  }
  const branchRaw = (await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim();
  const statusRaw = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const records = statusRaw.split("\0");
  const changed: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    const firstPath = record.slice(3);
    if (status.includes("R") || status.includes("C")) {
      const secondPath = records[index + 1] ?? "";
      index += 1;
      changed.push({ status, path: secondPath || firstPath });
    } else {
      changed.push({ status, path: firstPath });
    }
  }
  changed.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status));
  return {
    head,
    unborn,
    branch: branchRaw || null,
    detached: !branchRaw,
    statusRaw,
    changed,
  };
}

async function stagedObjectId(
  root: string,
  entry: { status: string; path: string },
): Promise<string | null> {
  const indexStatus = entry.status[0];
  if (!indexStatus || indexStatus === " " || indexStatus === "?" || indexStatus === "!") {
    return null;
  }
  const output = await git(
    root,
    ["ls-files", "--stage", "-z", "--", entry.path],
    64 * 1024,
  ).catch(() => "");
  const first = output.split("\0")[0] ?? "";
  const match = /^\d+\s+([0-9a-f]+)\s+\d+\t/.exec(first);
  return match?.[1] ?? null;
}

async function fingerprintFile(
  root: string,
  entry: { status: string; path: string },
  budget: { files: number; bytes: number },
  limits: WorkspaceSnapshotLimits,
  startedAt: number,
): Promise<{ fingerprint: FileFingerprint; complete: boolean; reason?: string }> {
  if (budget.files >= limits.maxFiles) {
    return {
      fingerprint: {
        path: entry.path,
        status: entry.status,
        size: null,
        mode: null,
        symlinkTarget: null,
        sha256: null,
        indexObjectId: null,
      },
      complete: false,
      reason: "file_budget_exceeded",
    };
  }
  if (Date.now() - startedAt >= limits.maxDurationMs) {
    return {
      fingerprint: {
        path: entry.path,
        status: entry.status,
        size: null,
        mode: null,
        symlinkTarget: null,
        sha256: null,
        indexObjectId: null,
      },
      complete: false,
      reason: "time_budget_exceeded",
    };
  }

  const indexObjectId = await stagedObjectId(root, entry);
  const absolute = path.join(root, entry.path);
  try {
    const info = await lstat(absolute);
    budget.files += 1;
    const mode = `0${(info.mode & 0o7777).toString(8)}`;
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      const sha256 = createHash("sha256").update(target).digest("hex");
      return {
        fingerprint: {
          path: entry.path,
          status: entry.status,
          size: Buffer.byteLength(target),
          mode,
          symlinkTarget: target,
          sha256,
          indexObjectId,
        },
        complete: true,
      };
    }
    if (!info.isFile()) {
      return {
        fingerprint: {
          path: entry.path,
          status: entry.status,
          size: info.size,
          mode,
          symlinkTarget: null,
          sha256: null,
          indexObjectId,
        },
        complete: true,
      };
    }
    if (budget.bytes + info.size > limits.maxBytes) {
      return {
        fingerprint: {
          path: entry.path,
          status: entry.status,
          size: info.size,
          mode,
          symlinkTarget: null,
          sha256: null,
          indexObjectId,
        },
        complete: false,
        reason: "byte_budget_exceeded",
      };
    }
    const data = await readFile(absolute);
    budget.bytes += data.length;
    return {
      fingerprint: {
        path: entry.path,
        status: entry.status,
        size: info.size,
        mode,
        symlinkTarget: null,
        sha256: createHash("sha256").update(data).digest("hex"),
        indexObjectId,
      },
      complete: true,
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      budget.files += 1;
      return {
        fingerprint: {
          path: entry.path,
          status: entry.status,
          size: null,
          mode: null,
          symlinkTarget: null,
          sha256: null,
          indexObjectId,
        },
        complete: true,
      };
    }
    return {
      fingerprint: {
        path: entry.path,
        status: entry.status,
        size: null,
        mode: null,
        symlinkTarget: null,
        sha256: null,
        indexObjectId,
      },
      complete: false,
      reason: `file_error:${code ?? "unknown"}`,
    };
  }
}

function observationFingerprint(value: Omit<WorkspaceObservation, "fingerprint">): string {
  return createHash("sha256")
    .update(JSON.stringify({
      repository: value.repository,
      head: value.head,
      unborn: value.unborn,
      branch: value.branch,
      detached: value.detached,
      worktreeIdentity: value.worktreeIdentity,
      statusDigest: value.statusDigest,
      files: value.files,
      completeness: value.completeness,
      reasons: value.reasons,
    }))
    .digest("hex");
}

export async function observeWorkspace(
  identity: WorkspaceIdentityRecord,
  limits: WorkspaceSnapshotLimits,
): Promise<WorkspaceObservation> {
  const startedAt = Date.now();
  const observedAt = new Date(startedAt).toISOString();
  const reasons = new Set<string>();
  const files: FileFingerprint[] = [];
  let head: string | null = null;
  let unborn = false;
  let branch: string | null = null;
  let detached = false;
  let statusDigest = createHash("sha256").update("").digest("hex");
  const budget = { files: 0, bytes: 0 };

  if (identity.repository && identity.gitRoot) {
    try {
      const before = await inspectGit(identity.gitRoot);
      head = before.head;
      unborn = before.unborn;
      branch = before.branch;
      detached = before.detached;
      statusDigest = createHash("sha256").update(before.statusRaw).digest("hex");
      for (const entry of before.changed) {
        const result = await fingerprintFile(identity.gitRoot, entry, budget, limits, startedAt);
        files.push(result.fingerprint);
        if (!result.complete && result.reason) reasons.add(result.reason);
        if (Date.now() - startedAt >= limits.maxDurationMs) {
          reasons.add("time_budget_exceeded");
          break;
        }
      }
      const after = await inspectGit(identity.gitRoot);
      const afterDigest = createHash("sha256").update(after.statusRaw).digest("hex");
      if (after.head !== before.head || afterDigest !== statusDigest) {
        reasons.add("concurrent_change");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "git_error";
      reasons.add(`git_error:${code}`);
    }
  } else {
    reasons.add("non_git_unscanned");
  }

  const completedAt = new Date().toISOString();
  const completeness: WorkspaceObservation["completeness"] = reasons.size === 0
    ? "complete"
    : files.length > 0 || identity.repository
      ? "partial"
      : "unknown";
  const base: Omit<WorkspaceObservation, "fingerprint"> = {
    observedAt,
    completedAt,
    repository: identity.repository,
    head,
    unborn,
    branch,
    detached,
    worktreeIdentity: identity.worktreeIdentity,
    statusDigest,
    files,
    completeness,
    reasons: [...reasons].sort(),
    inspectedFiles: budget.files,
    inspectedBytes: budget.bytes,
    maxFiles: limits.maxFiles,
    maxBytes: limits.maxBytes,
    maxDurationMs: limits.maxDurationMs,
  };
  return { ...base, fingerprint: observationFingerprint(base) };
}

export function compareWorkspace(
  previous: WorkspaceObservation | undefined,
  current: WorkspaceObservation,
): { drift: "none_detected" | "detected" | "unknown"; reasons: string[]; evidence: "present" | "changed" | "unchecked" } {
  if (!previous) {
    return { drift: "unknown", reasons: ["no_previous_observation"], evidence: "unchecked" };
  }
  if (current.completeness !== "complete" || previous.completeness !== "complete") {
    if (current.fingerprint !== previous.fingerprint) {
      return { drift: "detected", reasons: ["workspace_fingerprint_changed", ...current.reasons], evidence: "changed" };
    }
    return { drift: "unknown", reasons: [...new Set([...previous.reasons, ...current.reasons])], evidence: "unchecked" };
  }
  if (current.fingerprint !== previous.fingerprint) {
    return { drift: "detected", reasons: ["workspace_fingerprint_changed"], evidence: "changed" };
  }
  return { drift: "none_detected", reasons: [], evidence: "present" };
}
