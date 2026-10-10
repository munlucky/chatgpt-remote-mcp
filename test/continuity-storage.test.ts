import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rename, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { createServices, type McpServices } from "../src/mcp-server.js";
import { TaskStore } from "../src/continuity/task-store.js";
import { migrateWorkspace } from "../src/continuity/storage-migration.js";
import { commitJournal, prepareJournal } from "../src/continuity/storage-journal.js";
import * as journalModule from "../src/continuity/storage-journal.js";
import * as durability from "../src/continuity/storage-durability.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe.sequential("continuity storage integrity", () => {
  const roots: string[] = [];
  const services: McpServices[] = [];
  const stores: TaskStore[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(fs.open).mockReset();
    vi.mocked(fs.open).mockImplementation((await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open);
    for (const service of services.splice(0)) {
      await service.processManager.shutdown();
      await service.continuityService.close();
    }
    for (const store of stores.splice(0)) await store.close();
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture(closed = false) {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-storage-"));
    roots.push(root);
    const service = createServices(loadConfig({ MCP_AUTH_TOKEN: "storage-test", MCP_DEFAULT_CWD: root,
      MCP_CONTINUITY_STATE_DIR: path.join(root, "state") }, root));
    services.push(service);
    const created = await service.continuityService.create({ cwd: root, requestId: randomUUID(), objective: "preserve identifiers",
      checkpoint: { phase: "verify", completed: ["caller says test passed"], current: "inspect", remaining: [], changedPaths: [], evidenceRefs: [], blockers: [] } });
    const identity = await service.continuityService.workspaceIdentity.resolve(root);
    const prepared = await service.executionRecorder.prepare({ cwd: root, taskId: String(created.taskId), operationId: randomUUID(),
      toolKind: "run_script", semanticInput: { script: "private source must not be persisted" } });
    await service.executionRecorder.markSpawnFailed(prepared.record);
    if (closed) await service.continuityService.complete({ taskId: String(created.taskId), requestId: randomUUID(), expectedRevision: 1,
      outcome: "completed", summary: "legacy completion claim", evidenceRefs: [] });
    await service.continuityService.close();
    const directory = path.join(root, "state", "workspaces", identity.workspaceId);
    const stateFile = path.join(directory, "state.json");
    const executionFile = path.join(directory, "executions", `${prepared.record.operationId}.json`);
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    const execution = JSON.parse(await readFile(executionFile, "utf8"));
    state.schemaVersion = execution.schemaVersion = 1;
    await writeFile(stateFile, JSON.stringify(state));
    await writeFile(executionFile, JSON.stringify(execution));
    return { root, directory, stateFile, executionFile, state, execution, identity, taskId: String(created.taskId) };
  }
  function storeFor(root: string) {
    const store = new TaskStore({ stateDirectory: path.join(root, "state"), maxSnapshotBytes: 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024 });
    stores.push(store);
    return store;
  }
  it("backs up exact v1 bytes, preserves closed claims and identities, and is repeatable", async () => {
    const f = await fixture(true);
    const before = await readFile(f.stateFile, "utf8");
    const beforeExecution = await readFile(f.executionFile, "utf8");
    const store = storeFor(f.root);
    await store.initialize();
    const state = await store.readWorkspace(f.identity);
    expect(state.schemaVersion).toBe(2);
    expect(state.tasks[f.taskId]).toMatchObject({ taskId: f.taskId, status: "completed", summary: "legacy completion claim",
      legacy: { fromSchemaVersion: 1, checkpointClaims: "caller_claim", completionClaim: "caller_claim" } });
    expect(state.activeTaskId).toBeNull();
    expect(state.tasks[f.taskId]?.checkpoint).toEqual(f.state.tasks[f.taskId].checkpoint);
    expect(await readFile(path.join(f.directory, "schema-v1", "state.json"), "utf8")).toBe(before);
    expect(await readFile(path.join(f.directory, "schema-v1", "executions", `${f.execution.operationId}.json`), "utf8")).toBe(beforeExecution);
    const migrated = await readFile(f.stateFile, "utf8");
    await store.close();
    await storeFor(f.root).initialize();
    expect(await readFile(f.stateFile, "utf8")).toBe(migrated);
    expect(migrated).not.toContain('"verified"');
    expect(await readFile(f.executionFile, "utf8")).not.toContain("private source");
  });
  it.each(["revision", "enum", "receipt_owner", "filename", "dedupe_owner", "active_pointer"])("rejects corrupt %s before replacing v1 originals", async (failure) => {
    const f = await fixture();
    if (failure === "revision") f.state.tasks[f.taskId].revision = -1;
    if (failure === "enum") f.execution.state = "succeeded";
    if (failure === "receipt_owner") f.execution.taskId = randomUUID();
    if (failure === "filename") f.execution.operationId = randomUUID();
    if (failure === "dedupe_owner") Object.values(f.state.mutationDedupe).forEach((entry: any) => { entry.taskId = randomUUID(); });
    if (failure === "active_pointer") f.state.activeTaskId = randomUUID();
    await writeFile(f.stateFile, JSON.stringify(f.state));
    await writeFile(f.executionFile, JSON.stringify(f.execution));
    const before = await readFile(f.stateFile, "utf8");
    await expect(storeFor(f.root).initialize()).rejects.toMatchObject({ code: "state_corrupt" });
    expect(await readFile(f.stateFile, "utf8")).toBe(before);
    expect(await readdir(f.directory)).not.toContain("schema-v1");
  });
  it.each([1, 2, 3, 4, 5, 6])("recovers migration interrupted at atomic write %i", async (failAt) => {
    const f = await fixture();
    let calls = 0;
    await expect(migrateWorkspace(f.directory, f.identity.workspaceId, async (file, raw) => {
      if (++calls === failAt) throw new Error("injected interruption");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(`${file}.tmp`, raw);
      await rename(`${file}.tmp`, file);
    })).rejects.toThrow("injected interruption");
    const store = storeFor(f.root);
    await store.initialize();
    expect((await store.readWorkspace(f.identity)).schemaVersion).toBe(2);
    expect((await store.readExecution(f.identity.workspaceId, f.execution.operationId))?.state).toBe("spawn_failed");
  });
  it("restores complete legacy state offline and refuses rollback after newer writes", async () => {
    const f = await fixture(true);
    const original = await readFile(f.stateFile, "utf8");
    const store = storeFor(f.root);
    await store.initialize();
    await store.restoreLegacyBackup(f.identity.workspaceId);
    expect(await readFile(f.stateFile, "utf8")).toBe(original);
    const next = storeFor(f.root);
    await next.initialize();
    const state = await next.readWorkspace(f.identity);
    state.workspaceRevision += 1;
    await next.writeWorkspace(state);
    await expect(next.restoreLegacyBackup(f.identity.workspaceId)).rejects.toMatchObject({ code: "rollback_unsafe" });
    expect(JSON.parse(await readFile(f.stateFile, "utf8")).schemaVersion).toBe(2);
  });

  it.each([1, 2, 3, 4, 5])("recovers reconciliation and request result after failure at journal write %i", async (failAt) => {
    const f = await fixture();
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    const first = { ...f.execution, schemaVersion: 2 as const, state: "unknown" as const };
    const second = { ...first, operationId: randomUUID() };
    await service.continuityService.store.writeExecution(first);
    await service.continuityService.store.writeExecution(second);
    await writeFile(path.join(f.root, "counter.txt"), "once\n");
    const input = { taskId: f.taskId, requestId: randomUUID(), expectedRevision: 1,
      checkpoint: { ...f.state.tasks[f.taskId].checkpoint, current: "reconciled together",
        executionReconciliations: [first, second].map((record) => ({ operationId: record.operationId,
          resolution: "verified_no_retry" as const, evidenceRefs: [], note: "effect already inspected" })) } };
    let writes = 0;
    vi.spyOn(service.continuityService.store, "commitWorkspace").mockImplementationOnce(async (state, records) => {
      const journal = await prepareJournal(f.directory, state, records);
      await commitJournal(f.directory, journal, async (file, raw) => {
        if (++writes === failAt) throw new Error("injected journal failure");
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(`${file}.tmp`, raw);
        await rename(`${file}.tmp`, file);
      });
    });
    await expect(service.continuityService.update(input)).rejects.toThrow("injected journal failure");
    await service.continuityService.close();
    await service.continuityService.initialize();
    const recovered = await service.continuityService.store.readWorkspace(f.identity);
    const records = await service.continuityService.store.listExecutions(f.identity.workspaceId, f.taskId);
    const committed = failAt >= 3;
    expect(recovered.tasks[f.taskId]?.revision).toBe(committed ? 2 : 1);
    expect(records.every((record) => Boolean(record.callerResolution) === committed)).toBe(true);
    expect(Boolean(recovered.mutationDedupe[input.requestId])).toBe(committed);
    const replay = await service.continuityService.update(input);
    expect(replay).toEqual(recovered.mutationDedupe[input.requestId]?.result ?? {
      taskId: f.taskId, workspaceId: f.identity.workspaceId, revision: 2, workspaceRevision: 2, status: "active",
    });
    await expect(service.continuityService.update(input)).resolves.toEqual(replay);
    expect(await readFile(path.join(f.root, "counter.txt"), "utf8")).toBe("once\n");
    expect(service.processManager.list()).toHaveLength(0);
  });

  it("validates every reconciliation before writing any receipt", async () => {
    const f = await fixture();
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    await service.continuityService.store.writeExecution({ ...f.execution, schemaVersion: 2, state: "unknown" });
    await expect(service.continuityService.update({ taskId: f.taskId, requestId: randomUUID(), expectedRevision: 1,
      checkpoint: { ...f.state.tasks[f.taskId].checkpoint, executionReconciliations: [f.execution.operationId, randomUUID()]
        .map((operationId) => ({ operationId, resolution: "verified_no_retry", evidenceRefs: [] })) },
    })).rejects.toMatchObject({ code: "state_corrupt" });
    expect((await service.continuityService.store.readExecution(f.identity.workspaceId, f.execution.operationId))?.callerResolution).toBeUndefined();
    expect((await service.continuityService.store.readWorkspace(f.identity)).tasks[f.taskId]?.revision).toBe(1);
  });

  it("rejects cross-task receipt references in create and complete before saving", async () => {
    const f = await fixture(true);
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    const checkpoint = f.state.tasks[f.taskId].checkpoint;
    const foreign = { kind: "receipt" as const, operationId: f.execution.operationId };
    const before = await readFile(f.stateFile, "utf8");
    await expect(service.continuityService.create({ cwd: f.root, requestId: randomUUID(), objective: "new owner",
      checkpoint: { ...checkpoint, evidenceRefs: [foreign] } })).rejects.toMatchObject({ code: "state_corrupt" });
    expect(await readFile(f.stateFile, "utf8")).toBe(before);
    const created = await service.continuityService.create({ cwd: f.root, requestId: randomUUID(), objective: "new owner", checkpoint });
    const newBefore = await readFile(f.stateFile, "utf8");
    await expect(service.continuityService.complete({ taskId: String(created.taskId), requestId: randomUUID(), expectedRevision: 1,
      outcome: "completed", summary: "invalid other task proof", evidenceRefs: [foreign] })).rejects.toMatchObject({ code: "state_corrupt" });
    expect(await readFile(f.stateFile, "utf8")).toBe(newBefore);
    await service.continuityService.close();
    await storeFor(f.root).initialize();
  });

  it("rejects cross-task callerResolution evidence on write, read and restart", async () => {
    const f = await fixture(true);
    const service = services.at(-1)!;
    const created = await service.continuityService.create({ cwd: f.root, requestId: randomUUID(), objective: "new owner",
      checkpoint: f.state.tasks[f.taskId].checkpoint });
    const record = { ...f.execution, taskId: String(created.taskId), operationId: randomUUID(), schemaVersion: 2, state: "unknown",
      callerResolution: { operationId: "", resolution: "verified_no_retry", recordedAt: new Date().toISOString(),
        evidenceRefs: [{ kind: "receipt", operationId: f.execution.operationId }] } };
    record.callerResolution.operationId = record.operationId;
    await expect(service.continuityService.store.writeExecution(record)).rejects.toMatchObject({ code: "state_corrupt" });
    const file = path.join(f.directory, "executions", `${record.operationId}.json`);
    await writeFile(file, JSON.stringify(record));
    await expect(service.continuityService.store.readExecution(f.identity.workspaceId, record.operationId)).rejects.toMatchObject({ code: "state_corrupt" });
    await service.continuityService.close();
    await expect(storeFor(f.root).initialize()).rejects.toMatchObject({ code: "state_corrupt" });
  });

  it("preserves earlier backup bytes when v1 changes after rollback and upgrades again", async () => {
    const f = await fixture(true);
    const original = await readFile(f.stateFile, "utf8");
    const store = storeFor(f.root);
    await store.initialize();
    await store.restoreLegacyBackup(f.identity.workspaceId);
    const legacy = JSON.parse(await readFile(f.stateFile, "utf8"));
    legacy.tasks[f.taskId].summary = "v1 changed after offline rollback";
    legacy.workspaceRevision += 1;
    legacy.tasks[f.taskId].revision += 1;
    const changed = JSON.stringify(legacy);
    await writeFile(f.stateFile, changed);
    const next = storeFor(f.root);
    await next.initialize();
    expect((await next.readWorkspace(f.identity)).tasks[f.taskId]?.summary).toBe(legacy.tasks[f.taskId].summary);
    const manifest = JSON.parse(await readFile(path.join(f.directory, "schema-migration.json"), "utf8"));
    expect(manifest.backupDirectory).toMatch(/^schema-v1-[a-f0-9]{64}$/);
    expect(await readFile(path.join(f.directory, "schema-v1", "state.json"), "utf8")).toBe(original);
    expect(await readFile(path.join(f.directory, manifest.backupDirectory, "state.json"), "utf8")).toBe(changed);
    await next.restoreLegacyBackup(f.identity.workspaceId);
    expect(await readFile(f.stateFile, "utf8")).toBe(changed);
  });

  it("serializes two workspace commits and read recovery without deleting active journals", async () => {
    const f = await fixture();
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    const cwdB = path.join(f.root, "workspace-b");
    await mkdir(cwdB);
    const createdB = await service.continuityService.create({ cwd: cwdB, requestId: randomUUID(), objective: "second workspace",
      checkpoint: f.state.tasks[f.taskId].checkpoint });
    const identityB = await service.continuityService.workspaceIdentity.resolve(cwdB);
    const preparedB = await service.executionRecorder.prepare({ cwd: cwdB, taskId: String(createdB.taskId), operationId: randomUUID(),
      toolKind: "run_script", semanticInput: {} });
    await service.continuityService.store.writeExecution({ ...preparedB.record, state: "unknown" });
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const realCommit = journalModule.commitJournal;
    let enteredA = false;
    vi.spyOn(journalModule, "commitJournal").mockImplementation(async (directory, journal, write) => {
      let calls = 0;
      if (journal.workspaceId === f.identity.workspaceId) { enteredA = true; throw new Error("A failed before commit decision"); }
      return realCommit(directory, journal, async (file, raw, mode) => {
        calls += 1;
        if (calls === 4) throw new Error("B failed after receipt application");
        await write(file, raw, mode);
        if (calls === 1) { started(); await gate; }
      });
    });
    const inputB = { taskId: String(createdB.taskId), requestId: randomUUID(), expectedRevision: 1,
      checkpoint: { ...f.state.tasks[f.taskId].checkpoint, current: "B committed",
        executionReconciliations: [{ operationId: preparedB.record.operationId, resolution: "verified_no_retry" as const, evidenceRefs: [] }] } };
    const commitB = service.continuityService.update(inputB);
    const failureB = expect(commitB).rejects.toThrow("B failed after receipt application");
    await ready;
    const stateA = await fs.readFile(f.stateFile, "utf8").then((raw) => JSON.parse(raw));
    stateA.workspaceRevision += 1;
    const commitA = service.continuityService.store.commitWorkspace(stateA, []);
    const failureA = expect(commitA).rejects.toThrow("A failed before commit decision");
    let readFinished = false;
    const readB = service.continuityService.store.readWorkspace(identityB).then((state) => { readFinished = true; return state; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(enteredA).toBe(false);
    expect(readFinished).toBe(false);
    const directoryB = path.join(f.root, "state", "workspaces", identityB.workspaceId);
    expect((await readdir(path.join(directoryB, "transactions"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    release();
    await Promise.all([failureB, failureA]);
    const recoveredB = await readB;
    expect(recoveredB.tasks[String(createdB.taskId)]?.revision).toBe(2);
    expect((await service.continuityService.store.readExecution(identityB.workspaceId, preparedB.record.operationId))?.callerResolution?.resolution).toBe("verified_no_retry");
    expect((await service.continuityService.store.readWorkspace(f.identity)).workspaceRevision).toBe(1);
    await expect(service.continuityService.update(inputB)).resolves.toEqual(recoveredB.mutationDedupe[inputB.requestId]?.result);
    expect(service.processManager.list()).toHaveLength(0);
  });

  it.each(["payload-before", "payload-after", "marker-before", "marker-after"])("recovers journal cleanup failure at %s", async (boundary) => {
    const f = await fixture();
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    await service.continuityService.store.writeExecution({ ...f.execution, schemaVersion: 2, state: "unknown" });
    const remove = durability.removeDurably;
    let injected = false;
    vi.spyOn(durability, "removeDurably").mockImplementation(async (file) => {
      const target = boundary.startsWith("payload") ? file.endsWith(".json") : file.endsWith(".commit");
      if (!injected && target && file.includes("transactions")) {
        injected = true;
        if (boundary.endsWith("after")) await remove(file);
        throw new Error("cleanup sync failed");
      }
      await remove(file);
    });
    const input = { taskId: f.taskId, requestId: randomUUID(), expectedRevision: 1,
      checkpoint: { ...f.state.tasks[f.taskId].checkpoint,
        executionReconciliations: [{ operationId: f.execution.operationId, resolution: "verified_no_retry" as const, evidenceRefs: [] }] } };
    await expect(service.continuityService.update(input)).rejects.toThrow("cleanup sync failed");
    const recovered = await service.continuityService.store.readWorkspace(f.identity);
    expect(recovered.tasks[f.taskId]?.revision).toBe(2);
    await expect(service.continuityService.update(input)).resolves.toEqual(recovered.mutationDedupe[input.requestId]?.result);
    expect(await readdir(path.join(f.directory, "transactions"))).toEqual([]);
  });

  it.each(["before", "after"])("recovers migration pending cleanup failure %s deletion", async (boundary) => {
    const f = await fixture();
    const remove = durability.removeDurably;
    vi.spyOn(durability, "removeDurably").mockImplementationOnce(async (file) => {
      if (boundary === "after") await remove(file);
      throw new Error("pending cleanup sync failed");
    });
    await expect(migrateWorkspace(f.directory, f.identity.workspaceId, async (file, raw) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, raw);
    })).rejects.toThrow("pending cleanup sync failed");
    const store = storeFor(f.root);
    await store.initialize();
    const state = await store.readWorkspace(f.identity);
    state.workspaceRevision += 1;
    await store.writeWorkspace(state);
    await store.close();
    await expect(storeFor(f.root).initialize()).resolves.toBeUndefined();
  });

  it("propagates directory fsync failure and closes its handle after a deletion", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-durability-"));
    roots.push(root);
    const file = path.join(root, "decision.json");
    await writeFile(file, "{}");
    const close = vi.fn(async () => undefined);
    vi.mocked(fs.open).mockResolvedValueOnce({ sync: async () => { throw Object.assign(new Error("sync failed"), { code: "EIO" }); }, close } as any);
    await expect(durability.removeDurably(file)).rejects.toThrow("sync failed");
    expect(close).toHaveBeenCalledOnce();
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains a committed journal until an already-renamed receipt is synced again", async () => {
    const f = await fixture();
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    await service.continuityService.store.writeExecution({ ...f.execution, schemaVersion: 2, state: "unknown" });
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    let failing = true, successfulReceiptSyncs = 0;
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const target = String(file) === path.join(f.directory, "executions");
      const handle = target && process.platform === "win32"
        ? { sync: async () => undefined, close: async () => undefined } as fs.FileHandle
        : await realOpen(file, flags, mode);
      if (target) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const renamed = Boolean(JSON.parse(await readFile(f.executionFile, "utf8")).callerResolution);
          if (failing && renamed) throw Object.assign(new Error("receipt directory sync failed"), { code: "EIO" });
          await sync();
          if (renamed) successfulReceiptSyncs += 1;
        };
      }
      return handle;
    });
    const input = { taskId: f.taskId, requestId: randomUUID(), expectedRevision: 1,
      checkpoint: { ...f.state.tasks[f.taskId].checkpoint,
        executionReconciliations: [{ operationId: f.execution.operationId, resolution: "verified_no_retry" as const, evidenceRefs: [] }] } };
    await expect(service.continuityService.update(input)).rejects.toThrow("receipt directory sync failed");
    // The rename succeeded, but it must not be mistaken for durable receipt storage.
    expect(JSON.parse(await readFile(f.executionFile, "utf8")).callerResolution).toBeDefined();
    await expect(service.continuityService.store.readWorkspace(f.identity)).rejects.toThrow("receipt directory sync failed");
    expect(JSON.parse(await readFile(f.stateFile, "utf8")).tasks[f.taskId].revision).toBe(1);
    expect((await readdir(path.join(f.directory, "transactions"))).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    failing = false;
    const recovered = await service.continuityService.store.readWorkspace(f.identity);
    expect(successfulReceiptSyncs).toBeGreaterThan(0);
    expect(recovered.tasks[f.taskId]?.revision).toBe(2);
    await expect(service.continuityService.update(input)).resolves.toEqual(recovered.mutationDedupe[input.requestId]?.result);
    expect(await readdir(path.join(f.directory, "transactions"))).toEqual([]);
    expect(service.processManager.list()).toHaveLength(0);
  });

  it("syncs a reused backup after rename failure before replacing any legacy source", async () => {
    const f = await fixture();
    const beforeState = await readFile(f.stateFile, "utf8");
    const beforeReceipt = await readFile(f.executionFile, "utf8");
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    let failing = true, confirmedBackupWhileV1 = false;
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const target = String(file) === path.join(f.directory, "schema-v1", "executions");
      const handle = target && process.platform === "win32"
        ? { sync: async () => undefined, close: async () => undefined } as fs.FileHandle
        : await realOpen(file, flags, mode);
      if (target) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (failing) throw Object.assign(new Error("backup directory sync failed"), { code: "EIO" });
          await sync();
          if ((await readFile(f.stateFile, "utf8")) === beforeState) confirmedBackupWhileV1 = true;
        };
      }
      return handle;
    });
    await expect(storeFor(f.root).initialize()).rejects.toThrow("backup directory sync failed");
    expect(await readFile(path.join(f.directory, "schema-v1", "executions", `${f.execution.operationId}.json`), "utf8")).toBe(beforeReceipt);
    await expect(storeFor(f.root).initialize()).rejects.toThrow("backup directory sync failed");
    expect(await readFile(f.stateFile, "utf8")).toBe(beforeState);
    expect(await readFile(f.executionFile, "utf8")).toBe(beforeReceipt);
    expect(await readdir(f.directory)).not.toContain("schema-migration.json");
    failing = false;
    await storeFor(f.root).initialize();
    expect(confirmedBackupWhileV1).toBe(true);
    expect(JSON.parse(await readFile(f.stateFile, "utf8")).schemaVersion).toBe(2);
    expect(await readFile(path.join(f.directory, "schema-v1", "state.json"), "utf8")).toBe(beforeState);
  });

  it("requires a durable commit decision before applying targets and survives another partial interruption", async () => {
    const f = await fixture();
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    const first = { ...f.execution, schemaVersion: 2, state: "unknown" };
    const second = { ...first, operationId: randomUUID() };
    await service.continuityService.store.writeExecution(first);
    await service.continuityService.store.writeExecution(second);
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    let markerFailing = true, receiptFailing = false;
    const transactions = path.join(f.directory, "transactions");
    const executions = path.join(f.directory, "executions");
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const directory = String(file);
      const target = directory === transactions || directory === executions;
      const handle = target && process.platform === "win32"
        ? { sync: async () => undefined, close: async () => undefined } as fs.FileHandle
        : await realOpen(file, flags, mode);
      if (target) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const markerExists = directory === transactions && (await readdir(transactions)).some((name) => name.endsWith(".commit"));
          if (markerFailing && markerExists) throw Object.assign(new Error("decision sync failed"), { code: "EIO" });
          if (receiptFailing && directory === executions) throw Object.assign(new Error("partial receipt sync failed"), { code: "EIO" });
          await sync();
        };
      }
      return handle;
    });
    const input = { taskId: f.taskId, requestId: randomUUID(), expectedRevision: 1,
      checkpoint: { ...f.state.tasks[f.taskId].checkpoint,
        executionReconciliations: [first, second].map((record) => ({ operationId: record.operationId,
          resolution: "verified_no_retry" as const, evidenceRefs: [] })) } };
    await expect(service.continuityService.update(input)).rejects.toThrow("decision sync failed");
    await expect(service.continuityService.store.readWorkspace(f.identity)).rejects.toThrow("decision sync failed");
    expect(JSON.parse(await readFile(f.executionFile, "utf8")).callerResolution).toBeUndefined();
    markerFailing = false;
    receiptFailing = true;
    await expect(service.continuityService.store.readWorkspace(f.identity)).rejects.toThrow("partial receipt sync failed");
    const partial = await Promise.all([first, second].map(async (record) =>
      JSON.parse(await readFile(path.join(executions, `${record.operationId}.json`), "utf8"))));
    expect(partial.filter((record) => record.callerResolution)).toHaveLength(1);
    expect(JSON.parse(await readFile(f.stateFile, "utf8")).tasks[f.taskId].revision).toBe(1);
    expect((await readdir(transactions)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
    receiptFailing = false;
    const recovered = await service.continuityService.store.readWorkspace(f.identity);
    expect(recovered.tasks[f.taskId]?.revision).toBe(2);
    expect((await service.continuityService.store.listExecutions(f.identity.workspaceId, f.taskId)).every((record) => record.callerResolution?.resolution === "verified_no_retry")).toBe(true);
    await expect(service.continuityService.update(input)).resolves.toEqual(recovered.mutationDedupe[input.requestId]?.result);
    expect(await readdir(transactions)).toEqual([]);
  });

  it.each(["create", "complete"])("rejects %s dedupe success until its visible snapshot is durable", async (kind) => {
    const f = await fixture(kind === "create");
    const service = services.at(-1)!;
    await service.continuityService.initialize();
    const realOpen = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).open;
    const requestId = randomUUID();
    let failing = true;
    vi.mocked(fs.open).mockImplementation(async (file, flags, mode) => {
      const target = String(file) === f.directory;
      const handle = target && process.platform === "win32"
        ? { sync: async () => undefined, close: async () => undefined } as fs.FileHandle
        : await realOpen(file, flags, mode);
      if (target) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          const current = JSON.parse(await readFile(f.stateFile, "utf8"));
          if (failing && current.mutationDedupe[requestId]) throw Object.assign(new Error("snapshot sync failed"), { code: "EIO" });
          await sync();
        };
      }
      return handle;
    });
    const createInput = { cwd: f.root, requestId, objective: "durable create", checkpoint: f.state.tasks[f.taskId].checkpoint };
    const completeInput = { taskId: f.taskId, requestId, expectedRevision: 1,
      outcome: "completed" as const, summary: "durable completion", evidenceRefs: [] };
    const mutate = () => kind === "create" ? service.continuityService.create(createInput) : service.continuityService.complete(completeInput);
    await expect(mutate()).rejects.toThrow("snapshot sync failed");
    const visible = JSON.parse(await readFile(f.stateFile, "utf8"));
    expect(visible.mutationDedupe[requestId]).toBeDefined();
    await expect(mutate()).rejects.toThrow("snapshot sync failed");
    // Losing the in-memory failure state must not make the dedupe result usable.
    await service.continuityService.close();
    await expect(mutate()).rejects.toThrow("snapshot sync failed");
    failing = false;
    await expect(mutate()).resolves.toEqual(visible.mutationDedupe[requestId].result);
    expect(await readFile(f.stateFile, "utf8")).toBe(JSON.stringify(visible, null, 2) + "\n");
  });
});
