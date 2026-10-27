import { randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  assertHostExecutorAvailable,
  mapContainerPathToHost,
  parseHostPathMappings,
} from "../src/host-executor.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition did not become true before timeout");
}

describe("native host executor contract", () => {
  const cleanupPaths: string[] = [];
  const children: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            resolve();
          }, 3000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
    for (const target of cleanupPaths.splice(0)) {
      await rm(target, { recursive: true, force: true });
    }
  });

  it("maps configured container roots to Windows host roots without project hardcoding", () => {
    const mappings = parseHostPathMappings(
      "/shared=C:/dev;/host/home=C:/Users/moon",
    );

    expect(mapContainerPathToHost("/shared/project/sub", mappings)).toBe(
      "C:\\dev\\project\\sub",
    );
    expect(mapContainerPathToHost("/host/home/.codex", mappings)).toBe(
      "C:\\Users\\moon\\.codex",
    );
    expect(() => mapContainerPathToHost("/outside/project", mappings)).toThrow(
      "not covered",
    );
  });

  it("preserves POSIX host paths for macOS", () => {
    const mappings = parseHostPathMappings("/shared=/Users/dev/work space;/host/home=/Users/dev");
    expect(mapContainerPathToHost("/shared/project/sub", mappings)).toBe("/Users/dev/work space/project/sub");
    expect(mapContainerPathToHost("/host/home/.codex", mappings)).toBe("/Users/dev/.codex");
  });

  it.skipIf(process.platform === "win32")("manages a POSIX companion through the shared queue", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-posix-manager-"));
    cleanupPaths.push(root);
    const scripts = path.join(root, "scripts");
    const shared = path.join(root, "shared");
    await mkdir(scripts);
    await mkdir(shared);
    for (const file of ["host-executor-posix.mjs", "host-executor.mjs"]) {
      await copyFile(path.resolve("scripts", file), path.join(scripts, file));
    }
    await writeFile(path.join(root, ".env"), `SHARED_PATH="${shared}"\nMCP_HOST_EXECUTOR_ENABLED=true\n`);
    const manager = path.join(scripts, "host-executor-posix.mjs");
    const run = (action: string) => promisify(execFile)(process.execPath, [manager, action], {
      env: { ...process.env, MCP_BUILD_ID: "manager-test" },
    });
    try {
      expect((await run("start")).stdout).toContain("healthy");
      expect((await run("status")).stdout).toContain("healthy");
      expect((await run("start")).stdout).toContain("already healthy");
    } finally {
      await run("stop");
    }
    expect((await run("status")).stdout).toContain("stopped");
  });

  it("requires a fresh compatible agent heartbeat before host execution", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-host-status-"));
    cleanupPaths.push(root);
    await mkdir(root, { recursive: true });
    const config = {
      enabled: true,
      queueDir: root,
      pathMappings: [{ containerRoot: "/shared", hostRoot: "C:/dev" }],
      heartbeatMaxAgeMs: 1000,
    };

    await writeFile(
      path.join(root, "agent.json"),
      JSON.stringify({
        protocolVersion: 1,
        pid: 123,
        platform: "win32",
        arch: "x64",
        buildId: "build-a",
        startedAt: new Date().toISOString(),
        lastHeartbeatAt: new Date().toISOString(),
      }),
    );
    await expect(assertHostExecutorAvailable(config, "build-a")).resolves.toMatchObject({
      platform: "win32",
      buildId: "build-a",
    });

    await writeFile(
      path.join(root, "agent.json"),
      JSON.stringify({
        protocolVersion: 1,
        pid: 123,
        platform: "win32",
        arch: "x64",
        buildId: "build-a",
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        lastHeartbeatAt: new Date(Date.now() - 10_000).toISOString(),
      }),
    );
    await expect(assertHostExecutorAvailable(config, "build-a")).rejects.toThrow(
      "heartbeat is stale",
    );
  });

  it("refuses recovery without terminating an unverified live PID", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-host-recovery-"));
    cleanupPaths.push(root);
    const jobDir = path.join(root, "jobs", randomUUID());
    await mkdir(jobDir, { recursive: true });
    const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(victim);
    await writeFile(path.join(jobDir, "claim.json"), JSON.stringify({ protocolVersion: 1 }));
    await writeFile(path.join(jobDir, "state.json"), JSON.stringify({
      pid: victim.pid,
      startedAt: "2000-01-01T00:00:00.000Z",
    }));
    const agent = spawn(process.execPath, [path.resolve("scripts/host-executor.mjs"), "--queue", root], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(agent);
    let stderr = "";
    agent.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    await waitFor(() => agent.exitCode !== null || agent.signalCode !== null);
    expect(agent.exitCode).not.toBe(0);
    expect(stderr).toContain("Refusing to terminate unverified live PID");
    expect(victim.exitCode).toBeNull();
    expect(victim.signalCode).toBeNull();
    expect(() => process.kill(victim.pid!, 0)).not.toThrow();
    expect(JSON.parse(await readFile(path.join(jobDir, "claim.json"), "utf8"))).toEqual({ protocolVersion: 1 });
    await expect(readFile(path.join(jobDir, "result.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "win32").each([
    { holdMs: 1500, survives: true },
    { holdMs: 4500, survives: false },
  ])("handles a locked heartbeat file ($holdMs ms)", async ({ holdMs, survives }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-host-locked-heartbeat-"));
    cleanupPaths.push(root);
    const statusFile = path.join(root, "agent.json");
    const agent = spawn(process.execPath, [path.resolve("scripts/host-executor.mjs"), "--queue", root], {
      windowsHide: true, stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(agent);
    let stderr = "";
    agent.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    await waitFor(async () => {
      try { await readFile(statusFile); return true; } catch { return false; }
    });
    const before = JSON.parse(await readFile(statusFile, "utf8")).lastHeartbeatAt;
    const reader = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$f=[IO.File]::Open($env:MCP_TEST_STATUS,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite); try { Write-Output 'locked'; Start-Sleep -Milliseconds " + holdMs + " } finally { $f.Dispose() }",
    ], { windowsHide: true, env: { ...process.env, MCP_TEST_STATUS: statusFile }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(reader);
    let output = "";
    reader.stdout?.on("data", (chunk) => { output += chunk.toString(); });
    const readerClosed = new Promise<void>((resolve) => { reader.once("close", () => resolve()); });
    await waitFor(() => output.includes("locked"));
    await readerClosed;
    expect(reader.exitCode).toBe(0);
    if (survives) {
      await waitFor(async () => JSON.parse(await readFile(statusFile, "utf8")).lastHeartbeatAt !== before);
      expect(agent.exitCode, stderr).toBeNull();
      await writeFile(path.join(root, "agent.control.json"), JSON.stringify({ action: "stop" }));
      await waitFor(() => agent.exitCode !== null);
      expect(agent.exitCode).toBe(0);
    } else {
      await waitFor(() => agent.exitCode !== null);
      expect(agent.exitCode).toBe(1);
      const log = await readFile(path.join(root, "agent.log"), "utf8");
      expect(log).toContain("heartbeat failed:");
      expect(log).toMatch(/EPERM|EACCES|EBUSY/);
      expect(log).toContain("agent stopping signal=heartbeat-error");
      expect(stderr).toBe("");
    }
  }, 12000);

  it("executes through the host target and preserves tracked replay semantics", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-host-e2e-"));
    cleanupPaths.push(root);
    const workspace = path.join(root, "workspace");
    const queueDir = path.join(root, "queue");
    await mkdir(workspace, { recursive: true });
    await mkdir(queueDir, { recursive: true });

    const agent = spawn(
      process.execPath,
      [path.resolve("scripts/host-executor.mjs"), "--queue", queueDir],
      {
        cwd: process.cwd(),
        env: { ...process.env, MCP_HOST_EXECUTOR_BUILD_ID: "test-build" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(agent);
    let agentStderr = "";
    agent.stderr?.on("data", (chunk) => {
      agentStderr += chunk.toString();
    });

    await waitFor(async () => {
      try {
        const status = JSON.parse(
          await readFile(path.join(queueDir, "agent.json"), "utf8"),
        );
        return status.pid === agent.pid && status.buildId === "test-build";
      } catch {
        return false;
      }
    });

    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "test",
        MCP_DEFAULT_CWD: workspace,
        MCP_CONTINUITY_STATE_DIR: path.join(root, "state"),
        MCP_EXECUTION_TRACKING: "required",
        MCP_HOST_EXECUTOR_ENABLED: "true",
        MCP_HOST_EXECUTOR_QUEUE_DIR: queueDir,
        MCP_HOST_EXECUTOR_PATH_MAPPINGS: workspace + "=" + workspace,
        MCP_HOST_EXECUTOR_HEARTBEAT_MAX_AGE_MS: "3000",
        MCP_BUILD_ID: "test-build",
      },
      workspace,
    );
    config.host = "127.0.0.1";
    config.port = 0;

    const services = createServices(config);
    const server = await startHttpServer(config, services);
    try {
      const task = await services.continuityService.create({
        cwd: workspace,
        requestId: randomUUID(),
        objective: "host executor integration",
        checkpoint: {
          phase: "test",
          completed: [],
          current: "execute once",
          remaining: [],
          blockers: [],
          evidenceRefs: [],
          changedPaths: [],
        },
      });
      const endpoint =
        "http://127.0.0.1:" +
        (server.httpServer.address() as AddressInfo).port +
        "/mcp";

      const call = async (
        name: string,
        args: Record<string, unknown>,
      ): Promise<Record<string, any>> => {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            authorization: "Bearer test",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name, arguments: args },
          }),
        });
        const body = await response.json();
        expect(
          body.result.isError,
          JSON.stringify(body.result.structuredContent ?? body.result.content),
        ).not.toBe(true);
        return body.result.structuredContent;
      };

      const operationId = randomUUID();
      const args = {
        taskId: task.taskId,
        operationId,
        executionTarget: "host",
        workdir: workspace,
        cmd: "printf x >> host-effect; cat host-effect",
        yieldTimeMs: 3000,
      };

      const first = await call("exec_command", args);
      expect(first).toMatchObject({
        running: false,
        exitCode: 0,
        executionState: "exited",
      });
      expect(first.stdout).toBe("x");

      const replay = await call("exec_command", { ...args, yieldTimeMs: 0 });
      expect(replay).toMatchObject({
        duplicate: true,
        exitCode: 0,
      });
      expect(await readFile(path.join(workspace, "host-effect"), "utf8")).toBe("x");

      const stdinResult = await call("exec_command", {
        taskId: task.taskId,
        operationId: randomUUID(),
        executionTarget: "host",
        workdir: workspace,
        cmd: "IFS= read -r line; printf '<%s>' \"$line\"",
        stdin: "hello\n",
        yieldTimeMs: 3000,
      });
      expect(stdinResult).toMatchObject({ running: false, exitCode: 0 });
      expect(stdinResult.stdout).toBe("<hello>");

      const unreadInput = await call("exec_command", {
        taskId: task.taskId,
        operationId: randomUUID(),
        executionTarget: "host",
        workdir: workspace,
        cmd: "sleep .2",
        stdin: "x".repeat(4 * 1024 * 1024),
        timeoutMs: 5000,
        yieldTimeMs: 3000,
      });
      expect(unreadInput).toMatchObject({ running: false, exitCode: 0, timedOut: false });
      expect(agent.exitCode, agentStderr).toBeNull();

      const timedOut = await call("exec_command", {
        taskId: task.taskId,
        operationId: randomUUID(),
        executionTarget: "host",
        workdir: workspace,
        cmd: "sleep 10",
        timeoutMs: 150,
        yieldTimeMs: 3000,
      });
      expect(timedOut.running).toBe(false);
      expect(timedOut.timedOut).toBe(true);
      expect(timedOut.exitCode).not.toBe(0);

      const invalidShell = await call("exec_command", {
        taskId: task.taskId,
        operationId: randomUUID(),
        executionTarget: "host",
        workdir: workspace,
        shell: "missing-mcp-host-shell",
        cmd: "echo should-not-run",
        timeoutMs: 3000,
        yieldTimeMs: 5000,
      });
      expect(invalidShell).toMatchObject({ running: false, exitCode: 125, timedOut: false });
      expect(invalidShell.stderr).toContain("ENOENT");
      expect(agent.exitCode, agentStderr).toBeNull();

      const afterSpawnFailure = await call("exec_command", {
        taskId: task.taskId,
        operationId: randomUUID(),
        executionTarget: "host",
        workdir: workspace,
        cmd: "printf healthy",
        yieldTimeMs: 3000,
      });
      expect(afterSpawnFailure).toMatchObject({ running: false, exitCode: 0, stdout: "healthy" });

      await writeFile(
        path.join(queueDir, "agent.control.json"),
        JSON.stringify({ action: "stop", requestedAt: new Date().toISOString() }),
      );
      await waitFor(() => agent.exitCode !== null || agent.signalCode !== null, 5000);

      const offlineReplay = await call("exec_command", { ...args, yieldTimeMs: 0 });
      expect(offlineReplay).toMatchObject({ duplicate: true, exitCode: 0 });
      expect(await readFile(path.join(workspace, "host-effect"), "utf8")).toBe("x");
    } finally {
      await server.close();
      if (agent.exitCode === null && agent.signalCode === null) {
        await writeFile(
          path.join(queueDir, "agent.control.json"),
          JSON.stringify({ action: "stop", requestedAt: new Date().toISOString() }),
        );
        await waitFor(
          () => agent.exitCode !== null || agent.signalCode !== null,
          5000,
        ).catch(() => {
          throw new Error("host executor did not stop: " + agentStderr);
        });
      }
    }
  });
});
