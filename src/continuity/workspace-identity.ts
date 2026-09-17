import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { WorkspaceIdentityRecord } from "./task-types.js";

const execFileAsync = promisify(execFile);

export interface WorkspaceAlias {
  alias: string;
  canonical: string;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function mapAlias(input: string, aliases: WorkspaceAlias[]): string {
  const normalized = path.resolve(input);
  const matches = aliases
    .map((entry) => ({
      alias: path.resolve(entry.alias),
      canonical: path.resolve(entry.canonical),
    }))
    .filter((entry) => isWithin(entry.alias, normalized))
    .sort((a, b) => b.alias.length - a.alias.length);
  const selected = matches[0];
  if (!selected) return normalized;
  const suffix = path.relative(selected.alias, normalized);
  return path.resolve(selected.canonical, suffix);
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    return result.stdout.trim();
  } catch {
    return null;
  }
}

async function canonicalExisting(input: string): Promise<string> {
  return realpath(input).catch(() => path.resolve(input));
}

export class WorkspaceIdentityService {
  constructor(
    readonly installationId: string | (() => string),
    readonly aliases: WorkspaceAlias[],
  ) {}

  async resolve(cwd: string): Promise<WorkspaceIdentityRecord> {
    const mapped = mapAlias(cwd, this.aliases);
    const resolved = await canonicalExisting(mapped);
    const topLevel = await tryGit(resolved, ["rev-parse", "--show-toplevel"]);
    if (!topLevel) {
      const executionRoot = resolved;
      return {
        workspaceId: this.workspaceId(executionRoot),
        executionRoot,
        gitRoot: null,
        gitCommonDir: null,
        worktreeIdentity: executionRoot,
        repository: false,
      };
    }

    const executionRoot = await canonicalExisting(mapAlias(topLevel, this.aliases));
    const gitCommonRaw = await tryGit(executionRoot, ["rev-parse", "--git-common-dir"]);
    const gitDirRaw = await tryGit(executionRoot, ["rev-parse", "--git-dir"]);
    const gitCommonDir = gitCommonRaw
      ? await canonicalExisting(path.resolve(executionRoot, gitCommonRaw))
      : null;
    const gitDir = gitDirRaw
      ? await canonicalExisting(path.resolve(executionRoot, gitDirRaw))
      : executionRoot;
    return {
      workspaceId: this.workspaceId(`${executionRoot}\n${gitDir}`),
      executionRoot,
      gitRoot: executionRoot,
      gitCommonDir,
      worktreeIdentity: gitDir,
      repository: true,
    };
  }

  private workspaceId(identity: string): string {
    const installationId = typeof this.installationId === "function"
      ? this.installationId()
      : this.installationId;
    return createHash("sha256")
      .update(installationId)
      .update("\0")
      .update(identity)
      .digest("hex")
      .slice(0, 32);
  }
}
