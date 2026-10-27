import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpToolError } from "./errors.js";

export const HOST_EXECUTOR_PROTOCOL_VERSION = 1 as const;

export interface HostPathMapping {
  containerRoot: string;
  hostRoot: string;
}

export interface HostExecutorConfig {
  enabled: boolean;
  queueDir: string;
  pathMappings: HostPathMapping[];
  heartbeatMaxAgeMs: number;
}

export interface HostExecutorRequest {
  command: string;
  cwd: string;
  shell?: string | undefined;
  login: boolean;
  env?: Record<string, string> | undefined;
}

export interface HostExecutorStatus {
  protocolVersion: number;
  pid: number;
  platform: string;
  arch: string;
  startedAt: string;
  lastHeartbeatAt: string;
  buildId?: string | undefined;
}

export function parseHostPathMappings(value: string | undefined): HostPathMapping[] {
  if (!value?.trim()) return [];
  const mappings = value.split(";").map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("MCP_HOST_EXECUTOR_PATH_MAPPINGS entries must use container=host form");
    }
    const containerRoot = entry.slice(0, separator).trim();
    const hostRoot = entry.slice(separator + 1).trim();
    if (!path.posix.isAbsolute(containerRoot)) {
      throw new Error("MCP_HOST_EXECUTOR_PATH_MAPPINGS container paths must be absolute POSIX paths");
    }
    if (!path.win32.isAbsolute(hostRoot) && !path.posix.isAbsolute(hostRoot)) {
      throw new Error("MCP_HOST_EXECUTOR_PATH_MAPPINGS host paths must be absolute");
    }
    return {
      containerRoot: path.posix.normalize(containerRoot),
      hostRoot,
    };
  });
  return mappings.sort((left, right) => right.containerRoot.length - left.containerRoot.length);
}

export function mapContainerPathToHost(
  containerPath: string,
  mappings: HostPathMapping[],
): string {
  const normalized = path.posix.normalize(containerPath.replaceAll("\\", "/"));
  for (const mapping of mappings) {
    const relative = path.posix.relative(mapping.containerRoot, normalized);
    const covered =
      relative === "" ||
      (!relative.startsWith("../") && relative !== ".." && !path.posix.isAbsolute(relative));
    if (!covered) continue;
    if (relative === "") return mapping.hostRoot;
    const segments = relative.split("/").filter(Boolean);
    return !path.posix.isAbsolute(mapping.hostRoot) && path.win32.isAbsolute(mapping.hostRoot)
      ? path.win32.join(mapping.hostRoot, ...segments)
      : path.posix.join(mapping.hostRoot, ...segments);
  }
  throw new McpToolError(
    "other",
    `Host execution workdir is not covered by MCP_HOST_EXECUTOR_PATH_MAPPINGS: ${containerPath}`,
  );
}

function clientScriptPath(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../scripts/host-exec-client.mjs"),
    path.resolve(moduleDir, "../../scripts/host-exec-client.mjs"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporaryPath, filePath);
}

export async function assertHostExecutorAvailable(
  config: HostExecutorConfig,
  expectedBuildId?: string,
): Promise<HostExecutorStatus> {
  if (!config.enabled) {
    throw new McpToolError(
      "invalid_input",
      "Host execution is disabled. Set MCP_HOST_EXECUTOR_ENABLED=true and restart the service.",
    );
  }
  if (config.pathMappings.length === 0) {
    throw new McpToolError("other", "Host execution has no configured path mappings");
  }

  let status: HostExecutorStatus;
  try {
    status = JSON.parse(
      await readFile(path.join(config.queueDir, "agent.json"), "utf8"),
    ) as HostExecutorStatus;
  } catch {
    throw new McpToolError(
      "persistence_unavailable",
      "Native host executor is not running or its status is unavailable",
    );
  }
  if (status.protocolVersion !== HOST_EXECUTOR_PROTOCOL_VERSION) {
    throw new McpToolError(
      "state_corrupt",
      `Native host executor protocol mismatch: expected ${HOST_EXECUTOR_PROTOCOL_VERSION}, got ${status.protocolVersion}`,
    );
  }
  const heartbeatAt = Date.parse(status.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatAt) || Date.now() - heartbeatAt > config.heartbeatMaxAgeMs) {
    throw new McpToolError(
      "persistence_unavailable",
      "Native host executor heartbeat is stale; restart it before host execution",
    );
  }
  if (
    expectedBuildId &&
    expectedBuildId !== "unknown" &&
    status.buildId &&
    status.buildId !== "unknown" &&
    status.buildId !== expectedBuildId
  ) {
    throw new McpToolError(
      "state_corrupt",
      `Native host executor build mismatch: service=${expectedBuildId}, host=${status.buildId}`,
    );
  }
  return status;
}

export async function createHostExecutorJob(
  config: HostExecutorConfig,
  request: HostExecutorRequest,
): Promise<{ jobDir: string; clientScript: string; cleanup: () => Promise<void> }> {
  const jobsDir = path.join(config.queueDir, "jobs");
  await mkdir(jobsDir, { recursive: true, mode: 0o700 });
  const jobDir = path.join(jobsDir, randomUUID());
  await mkdir(jobDir, { mode: 0o700 });
  await atomicWriteJson(path.join(jobDir, "request.json"), {
    protocolVersion: HOST_EXECUTOR_PROTOCOL_VERSION,
    jobId: path.basename(jobDir),
    command: request.command,
    cwd: request.cwd,
    shell: request.shell,
    login: request.login,
    env: request.env,
    createdAt: new Date().toISOString(),
  });
  return {
    jobDir,
    clientScript: clientScriptPath(),
    cleanup: () => rm(jobDir, { recursive: true, force: true }),
  };
}
