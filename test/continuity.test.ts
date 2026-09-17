import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { createMcpServer, createServices, type McpServices } from "../src/mcp-server.js";

const execFileAsync = promisify(execFile);

function checkpoint(current = "continue implementation") {
  return {
    phase: "implementation",
    completed: [] as string[],
    current,
    remaining: ["verify and complete"],
    changedPaths: [] as string[],
    evidenceRefs: [],
    blockers: [] as string[],
  };
}

async function createRoot(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function servicesFor(root: string, stateDirectory = path.join(root, "state")): McpServices {
  const config = loadConfig(
    {
      MCP_AUTH_TOKEN: "continuity-test",
      MCP_DEFAULT_CWD: root,
      MCP_CONTINUITY_STATE_DIR: stateDirectory,
      MCP_CONTINUITY_SNAPSHOT_MAX_DURATION_MS: "5000",
      MCP_CONTINUITY_SNAPSHOT_MAX_FILES: "500",
      MCP_CONTINUITY_SNAPSHOT_MAX_BYTES: String(32 * 1024 * 1024),
    },
    root,
  );
  return createServices(config);
}

async function closeServices(services: McpServices | undefined): Promise<void> {
  if (!services) return;
  await services.processManager.shutdown().catch(() => undefined);
  await services.continuityService.close().catch(() => undefined);
}

describe.sequential("durable task continuity", () => {
  const roots: string[] = [];
  const openServices: McpServices[] = [];

  afterEach(async () => {
    while (openServices.length > 0) {
      await closeServices(openServices.pop());
    }
    while (roots.length > 0) {
      await rm(roots.pop()!, { recursive: true, force: true });
    }
  });

  it("deduplicates mutations and rejects stale concurrent revisions without auto-merge", async () => {
    const root = await createRoot("mcp-continuity-cas-");
    roots.push(root);
    const services = servicesFor(root);
    openServices.push(services);
    await services.continuityService.initialize();

    const requestId = randomUUID();
    const createInput = {
      cwd: root,
      requestId,
      objective: "implement durable continuity",
      checkpoint: checkpoint(),
    };
    const created = await services.continuityService.create(createInput);
    expect(created).toMatchObject({ revision: 1, status: "active" });
    await expect(services.continuityService.create(createInput)).resolves.toEqual(created);
    await expect(
      services.continuityService.create({
        ...createInput,
        objective: "different objective with reused request id",
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    const taskId = String(created.taskId);
    const updates = await Promise.allSettled([
      services.continuityService.update({
        taskId,
        requestId: randomUUID(),
        expectedRevision: 1,
        checkpoint: checkpoint("writer A"),
      }),
      services.continuityService.update({
        taskId,
        requestId: randomUUID(),
        expectedRevision: 1,
        checkpoint: checkpoint("writer B"),
      }),
    ]);
    expect(updates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = updates.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ code: "revision_conflict" }),
    });

    const context = await services.continuityService.context({ taskId });
    expect(context).toMatchObject({
      selection: "selected",
      task: { taskId, revision: 2, status: "active" },
    });
  });

  it("returns multiple active candidates read-only instead of guessing or mutating", async () => {
    const base = await createRoot("mcp-continuity-candidates-");
    roots.push(base);
    const state = path.join(base, "state");
    const first = path.join(base, "first");
    const second = path.join(base, "second");
    await mkdir(first);
    await mkdir(second);
    const services = servicesFor(first, state);
    openServices.push(services);
    await services.continuityService.initialize();

    await services.continuityService.create({
      cwd: first,
      requestId: randomUUID(),
      objective: "first task",
      checkpoint: checkpoint("first"),
    });
    await services.continuityService.create({
      cwd: second,
      requestId: randomUUID(),
      objective: "second task",
      checkpoint: checkpoint("second"),
    });

    const context = await services.continuityService.context({});
    expect(context).toMatchObject({
      selection: "selection_required",
      candidateSearchComplete: true,
      resume: "selection_required",
    });
    expect(context.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ objective: "first task" }),
        expect.objectContaining({ objective: "second task" }),
      ]),
    );
  });

  it("tracks exec_command before spawn and never re-spawns the same operationId", async () => {
    const root = await createRoot("mcp-continuity-exec-");
    roots.push(root);
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "continuity-test",
        MCP_DEFAULT_CWD: root,
        MCP_CONTINUITY_STATE_DIR: path.join(root, "state"),
      },
      root,
    );
    const services = createServices(config);
    openServices.push(services);
    const server = createMcpServer(config, services);
    const client = new Client({ name: "continuity-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const created = await client.callTool({
        name: "checkpoint_work",
        arguments: {
          mode: "create",
          cwd: root,
          requestId: randomUUID(),
          objective: "run exactly once",
          checkpoint: checkpoint("execute command"),
        },
      });
      expect(created.isError).not.toBe(true);
      const taskId = String((created.structuredContent as Record<string, unknown>).taskId);
      const operationId = randomUUID();
      const args = {
        taskId,
        operationId,
        cmd: "printf 'once\\n' >> counter.txt",
        workdir: root,
        yieldTimeMs: 3000,
      };

      const first = await client.callTool({ name: "exec_command", arguments: args });
      expect(first.isError).not.toBe(true);
      expect(first.structuredContent).toMatchObject({
        taskId,
        operationId,
        completed: true,
        executionState: "exited",
      });

      const duplicate = await client.callTool({ name: "exec_command", arguments: args });
      expect(duplicate.isError).not.toBe(true);
      expect(duplicate.structuredContent).toMatchObject({
        taskId,
        operationId,
        duplicate: true,
        executionState: "exited",
      });
      expect(await readFile(path.join(root, "counter.txt"), "utf8")).toBe("once\n");

      const conflict = await client.callTool({
        name: "exec_command",
        arguments: { ...args, cmd: "printf 'twice\\n' >> counter.txt" },
      });
      expect(conflict.isError).toBe(true);
      expect(conflict.structuredContent).toMatchObject({ code: "idempotency_conflict" });
      expect(await readFile(path.join(root, "counter.txt"), "utf8")).toBe("once\n");

      const context = await client.callTool({
        name: "get_work_context",
        arguments: { taskId },
      });
      expect(context.isError).not.toBe(true);
      expect(context.structuredContent).toMatchObject({
        executions: {
          recent: expect.arrayContaining([
            expect.objectContaining({ operationId, state: "exited", exitCode: 0 }),
          ]),
        },
      });
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("marks previous-boot unsettled execution unknown and requires explicit reconciliation", async () => {
    const root = await createRoot("mcp-continuity-restart-");
    roots.push(root);
    const stateDirectory = path.join(root, "state");
    const firstServices = servicesFor(root, stateDirectory);
    await firstServices.continuityService.initialize();
    const created = await firstServices.continuityService.create({
      cwd: root,
      requestId: randomUUID(),
      objective: "recover after restart",
      checkpoint: checkpoint("before restart"),
    });
    const taskId = String(created.taskId);
    const operationId = randomUUID();
    const prepared = await firstServices.executionRecorder.prepare({
      taskId,
      operationId,
      cwd: root,
      toolKind: "exec_command",
      semanticInput: { cmd: "external-side-effect" },
    });
    await firstServices.executionRecorder.markRunning(prepared.record, randomUUID());
    await firstServices.continuityService.close();
    await firstServices.processManager.shutdown();

    const secondServices = servicesFor(root, stateDirectory);
    openServices.push(secondServices);
    await secondServices.continuityService.initialize();
    const context = await secondServices.continuityService.context({ taskId });
    expect(context).toMatchObject({
      executions: {
        unsettled: expect.arrayContaining([
          expect.objectContaining({ operationId, state: "unknown" }),
        ]),
      },
    });
    await expect(
      secondServices.continuityService.complete({
        taskId,
        requestId: randomUUID(),
        expectedRevision: 1,
        outcome: "completed",
        summary: "should not complete yet",
        evidenceRefs: [],
      }),
    ).rejects.toMatchObject({ code: "unresolved_execution" });

    const updated = await secondServices.continuityService.update({
      taskId,
      requestId: randomUUID(),
      expectedRevision: 1,
      checkpoint: {
        ...checkpoint("reconciled unknown execution"),
        executionReconciliations: [
          {
            operationId,
            resolution: "verified_no_retry" as const,
            evidenceRefs: [],
            note: "Current workspace was inspected; do not retry the uncertain operation.",
          },
        ],
      },
    });
    expect(updated).toMatchObject({ revision: 2 });
    await expect(
      secondServices.continuityService.complete({
        taskId,
        requestId: randomUUID(),
        expectedRevision: 2,
        outcome: "completed",
        summary: "explicitly reconciled",
        evidenceRefs: [],
      }),
    ).resolves.toMatchObject({ status: "completed", revision: 3 });
  });

  it("detects index-only drift even when status and worktree bytes are unchanged", async () => {
    const root = await createRoot("mcp-continuity-git-");
    roots.push(root);
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "continuity@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Continuity Test"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "base\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "base"], { cwd: root });

    await writeFile(path.join(root, "tracked.txt"), "index-a\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "worktree-b\n");

    const services = servicesFor(root);
    openServices.push(services);
    await services.continuityService.initialize();
    const created = await services.continuityService.create({
      cwd: root,
      requestId: randomUUID(),
      objective: "detect staged content drift",
      checkpoint: checkpoint("anchored at index A/worktree B"),
    });
    const taskId = String(created.taskId);
    const before = await services.continuityService.context({ taskId });
    const beforeTask = before.task as Record<string, any>;
    const beforeFile = beforeTask.lastObservedWorkspace.files.find(
      (file: Record<string, unknown>) => file.path === "tracked.txt",
    );
    expect(beforeFile).toMatchObject({ status: "MM", sha256: expect.any(String), indexObjectId: expect.any(String) });

    await writeFile(path.join(root, "tracked.txt"), "index-c\n");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "worktree-b\n");

    const after = await services.continuityService.context({ taskId });
    expect(after).toMatchObject({ drift: "detected" });
    const observation = after.observation as Record<string, any>;
    const afterFile = observation.files.find(
      (file: Record<string, unknown>) => file.path === "tracked.txt",
    );
    expect(afterFile.status).toBe(beforeFile.status);
    expect(afterFile.sha256).toBe(beforeFile.sha256);
    expect(afterFile.indexObjectId).not.toBe(beforeFile.indexObjectId);
  });

  it("normalizes explicit workspace aliases and enforces a single durable writer", async () => {
    const base = await createRoot("mcp-continuity-alias-");
    roots.push(base);
    const canonical = path.join(base, "canonical");
    const alias = path.join(base, "alias");
    const project = path.join(canonical, "project");
    await mkdir(project, { recursive: true });
    const stateDirectory = path.join(base, "state");
    const config = loadConfig(
      {
        MCP_AUTH_TOKEN: "continuity-test",
        MCP_DEFAULT_CWD: canonical,
        MCP_CONTINUITY_STATE_DIR: stateDirectory,
        MCP_WORKSPACE_ALIASES: `${alias}=${canonical}`,
      },
      base,
    );
    const firstServices = createServices(config);
    openServices.push(firstServices);
    await firstServices.continuityService.initialize();
    const created = await firstServices.continuityService.create({
      cwd: project,
      requestId: randomUUID(),
      objective: "alias identity",
      checkpoint: checkpoint("canonical path"),
    });
    const taskId = String(created.taskId);

    const viaAlias = await firstServices.continuityService.context({
      cwd: path.join(alias, "project"),
    });
    expect(viaAlias).toMatchObject({
      selection: "selected",
      task: { taskId },
    });

    const secondServices = createServices(config);
    await expect(secondServices.continuityService.initialize()).rejects.toMatchObject({
      code: "persistence_unavailable",
    });
    await secondServices.continuityService.close().catch(() => undefined);
    await firstServices.continuityService.close();
    const thirdServices = createServices(config);
    openServices.push(thirdServices);
    await expect(thirdServices.continuityService.initialize()).resolves.toBeUndefined();
  });
});
