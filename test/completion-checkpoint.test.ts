import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices, type McpServices } from "../src/mcp-server.js";

const terminal = { phase: "completed", completed: ["verified"], current: "verification finished", remaining: [] as string[], blockers: [] as string[], changedPaths: [] };

describe("terminal checkpoint contract", () => {
  const roots: string[] = [];
  const services: McpServices[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const s of services.splice(0)) { await s.processManager.shutdown(); await s.continuityService.close(); }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture(checkpoint = { ...terminal, phase: "implementation", remaining: ["verify"] }) {
    const root = await mkdtemp(path.join(os.tmpdir(), "mcp-terminal-")); roots.push(root);
    const config = loadConfig({ MCP_AUTH_TOKEN: "synthetic", MCP_DEFAULT_CWD: root, MCP_CONTINUITY_STATE_DIR: path.join(root, "state") }, root);
    const s = createServices(config); services.push(s);
    const created = await s.continuityService.create({ cwd: root, requestId: randomUUID(), objective: "synthetic completion", checkpoint: { ...checkpoint, evidenceRefs: [] } });
    const identity = await s.continuityService.workspaceIdentity.resolve(root);
    const file = path.join(root, "state", "workspaces", identity.workspaceId, "state.json");
    const input = { taskId: String(created.taskId), requestId: randomUUID(), expectedRevision: 1, outcome: "completed" as const, summary: "verified", evidenceRefs: [] };
    return { s, config, identity, file, input };
  }
  it.each([
    { ...terminal, remaining: ["verify"] }, { ...terminal, blockers: ["blocked"] },
    { ...terminal, phase: "verify" }, { ...terminal, current: "  " },
  ])("rejects a conflicting checkpoint without a file change", async (checkpoint) => {
    const f = await fixture(checkpoint);
    const before = await readFile(f.file, "utf8");
    await expect(f.s.continuityService.complete(f.input)).rejects.toMatchObject({ code: "completion_checkpoint_conflict" });
    expect(await readFile(f.file, "utf8")).toBe(before);
  });
  it("persists final checkpoint, pointer and dedupe together across restart", async () => {
    const f = await fixture();
    const input = { ...f.input, finalCheckpoint: terminal };
    const result = await f.s.continuityService.complete(input);
    await expect(f.s.continuityService.complete(input)).resolves.toEqual(result);
    await expect(f.s.continuityService.complete({ ...input, finalCheckpoint: { ...terminal, current: "different" } }))
      .rejects.toMatchObject({ code: "idempotency_conflict" });
    const state = JSON.parse(await readFile(f.file, "utf8"));
    expect(state).toMatchObject({ schemaVersion: 2, activeTaskId: null, tasks: { [input.taskId]: { status: "completed", revision: 2, checkpoint: terminal } } });
    await f.s.continuityService.close();
    const restarted = createServices(f.config); services.push(restarted);
    await expect(restarted.continuityService.complete(input)).resolves.toEqual(result);
    expect((await restarted.continuityService.context({ taskId: input.taskId })).task).toMatchObject({ revision: 2, checkpoint: terminal });
  });
  it("rejects stale revisions and oversized terminal checkpoints", async () => {
    const f = await fixture();
    await expect(f.s.continuityService.complete({ ...f.input, expectedRevision: 99, finalCheckpoint: terminal }))
      .rejects.toMatchObject({ code: "revision_conflict" });
    await expect(f.s.continuityService.complete({ ...f.input, finalCheckpoint: { ...terminal, current: "x".repeat(2049) } }))
      .rejects.toMatchObject({ code: "completion_checkpoint_conflict" });
    const before = await readFile(f.file, "utf8");
    vi.spyOn(f.s.continuityService.store, "writeWorkspace").mockRejectedValueOnce(new Error("synthetic write failure"));
    await expect(f.s.continuityService.complete({ ...f.input, finalCheckpoint: terminal })).rejects.toThrow("synthetic write failure");
    expect(await readFile(f.file, "utf8")).toBe(before);
    await f.s.continuityService.close();
    const restarted = createServices(f.config); services.push(restarted);
    expect((await restarted.continuityService.context({ taskId: f.input.taskId })).task).toMatchObject({ status: "active", revision: 1 });
  });
  it("warns on legacy inconsistency without rewriting and preserves omitted-input replay", async () => {
    const f = await fixture(terminal);
    const result = await f.s.continuityService.complete(f.input);
    const state = await f.s.continuityService.store.readWorkspace(f.identity);
    state.tasks[f.input.taskId]!.checkpoint.remaining = ["legacy unresolved claim"];
    await f.s.continuityService.store.writeWorkspace(state);
    const before = await readFile(f.file, "utf8");
    for (const format of ["summary", "full"] as const) {
      expect(await f.s.continuityService.context({ taskId: f.input.taskId, format })).toMatchObject({ warnings: ["completion_checkpoint_conflict"] });
    }
    await expect(f.s.continuityService.complete(f.input)).resolves.toEqual(result);
    await expect(f.s.continuityService.complete({ ...f.input, finalCheckpoint: terminal })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await readFile(f.file, "utf8")).toBe(before);
  });
  it("normalizes abandonment and preserves remaining and blockers", async () => {
    const f = await fixture({ ...terminal, phase: "implementation", remaining: ["verify"], blockers: ["waiting"] });
    await f.s.continuityService.complete({ ...f.input, outcome: "abandoned" });
    expect((await f.s.continuityService.context({ taskId: f.input.taskId })).task)
      .toMatchObject({ status: "abandoned", checkpoint: { phase: "abandoned", remaining: ["verify"], blockers: ["waiting"] } });
  });
});
