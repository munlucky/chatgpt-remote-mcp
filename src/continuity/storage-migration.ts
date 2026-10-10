import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { McpToolError } from "../errors.js";
import { parseExecution, parseWorkspace, validateOwnership } from "./storage-schema.js";
import { removeDurably, syncDirectory, syncFileAndParents } from "./storage-durability.js";

type AtomicWrite = (file: string, body: string, mode: number) => Promise<void>;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const body = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const markerSchema = z.strictObject({
  schemaVersion: z.literal(1), from: z.literal(1), to: z.literal(2),
  backupDirectory: z.string().regex(/^schema-v1(?:-[a-f0-9]{64})?$/).default("schema-v1"),
  files: z.array(z.strictObject({
    path: z.string().regex(/^(state\.json|executions\/[0-9a-fA-F-]{36}\.json)$/),
    before: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1),
});

async function optional(file: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function marker(directory: string, name = "schema-migration.json") {
  const raw = await optional(path.join(directory, name));
  if (raw === null) return null;
  try { return markerSchema.parse(JSON.parse(raw)); }
  catch { throw new McpToolError("state_corrupt", "Invalid continuity migration marker"); }
}

export async function workspaceFiles(directory: string): Promise<Array<{ path: string; raw: string }>> {
  const raw = await optional(path.join(directory, "state.json"));
  const files = raw === null ? [] : [{ path: "state.json", raw }];
  let entries;
  try { entries = await readdir(path.join(directory, "executions"), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return files; throw error; }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    if (!/^[0-9a-fA-F-]{36}\.json$/.test(entry.name)) throw new McpToolError("state_corrupt", "Invalid execution filename");
    const relative = `executions/${entry.name}`;
    files.push({ path: relative, raw: await readFile(path.join(directory, relative), "utf8") });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function validateWorkspaceFiles(files: Array<{ path: string; raw: string }>, workspaceId: string) {
  const snapshot = files.find((file) => file.path === "state.json");
  if (!snapshot) {
    if (files.length) throw new McpToolError("state_corrupt", "Execution records have no workspace snapshot");
    return null;
  }
  const state = parseWorkspace(snapshot.raw, snapshot.path);
  if (state.workspace.workspaceId !== workspaceId) throw new McpToolError("state_corrupt", "Workspace directory ownership mismatch");
  const records = files.filter((file) => file.path !== "state.json").map((file) => {
    const record = parseExecution(file.raw, file.path);
    if (file.path !== `executions/${record.operationId}.json`) throw new McpToolError("state_corrupt", "Execution filename ownership mismatch");
    return record;
  });
  validateOwnership(state, records, snapshot.path);
  return state;
}

function transformed(file: { path: string; raw: string }): string {
  return body(file.path === "state.json" ? parseWorkspace(file.raw, file.path) : parseExecution(file.raw, file.path));
}

export async function migrateWorkspace(directory: string, workspaceId: string, write: AtomicWrite): Promise<void> {
  const existingMarker = await marker(directory);
  const files = await workspaceFiles(directory);
  validateWorkspaceFiles(files, workspaceId);
  const pendingPath = path.join(directory, "schema-migration.pending");
  if (existingMarker && await optional(pendingPath) === null) {
    if (files.some((file) => JSON.parse(file.raw).schemaVersion !== 2)) {
      throw new McpToolError("state_corrupt", "Completed migration contains legacy records; restore the complete backup before downgrade");
    }
    await syncDirectory(directory);
    return;
  }
  if (!existingMarker && !files.some((file) => JSON.parse(file.raw).schemaVersion === 1)) return;
  let migration = existingMarker;
  if (!migration) {
    if (files.some((file) => JSON.parse(file.raw).schemaVersion !== 1)) throw new McpToolError("state_corrupt", "Mixed schema without a migration marker");
    const rollback = await marker(directory, "schema-rollback.json");
    // A completed offline restore authorizes a new backup generation. Keep
    // the earlier bytes intact when the v1 server has since changed state.
    if (rollback) {
      for (const entry of rollback.files) {
        const original = await optional(path.join(directory, rollback.backupDirectory, entry.path));
        if (original === null || hash(original) !== entry.before) throw new McpToolError("state_corrupt", "Restored backup integrity check failed");
      }
    }
    const backupDirectory = rollback
      ? `schema-v1-${hash(body(files.map((file) => ({ path: file.path, before: hash(file.raw) }))))}`
      : "schema-v1";
    const entries = [];
    for (const file of files) {
      const backup = path.join(directory, backupDirectory, file.path);
      const previous = await optional(backup);
      if (previous !== null && previous !== file.raw) throw new McpToolError("state_corrupt", "Legacy backup does not match original state");
      if (previous === null) await write(backup, file.raw, 0o600);
      await syncFileAndParents(backup, directory);
      entries.push({ path: file.path, before: hash(file.raw), after: hash(transformed(file)) });
    }
    migration = { schemaVersion: 1 as const, from: 1 as const, to: 2 as const, backupDirectory, files: entries };
    // Pending must exist before the manifest can authorize replacement.
    await write(pendingPath, "migration\n", 0o600);
    await write(path.join(directory, "schema-migration.json"), body(migration), 0o600);
  }
  for (const entry of migration.files) {
    const original = await optional(path.join(directory, migration.backupDirectory, entry.path));
    if (original === null || hash(original) !== entry.before || hash(transformed({ path: entry.path, raw: original })) !== entry.after) {
      throw new McpToolError("state_corrupt", "Legacy backup integrity check failed");
    }
    await syncFileAndParents(path.join(directory, migration.backupDirectory, entry.path), directory);
    const current = await optional(path.join(directory, entry.path));
    if (current === null || ![entry.before, entry.after].includes(hash(current))) throw new McpToolError("state_corrupt", "State changed during migration");
    if (hash(current) !== entry.after) await write(path.join(directory, entry.path), transformed({ path: entry.path, raw: original }), 0o600);
    await syncFileAndParents(path.join(directory, entry.path), directory);
  }
  await removeDurably(pendingPath);
}

export async function restoreV1Workspace(directory: string, write: AtomicWrite): Promise<void> {
  const migration = await marker(directory);
  if (!migration) throw new McpToolError("rollback_unavailable", "No legacy migration backup exists");
  const files = await workspaceFiles(directory);
  if (files.length !== migration.files.length) throw new McpToolError("rollback_unsafe", "Records changed after migration");
  const originals = [];
  for (const entry of migration.files) {
    const current = files.find((file) => file.path === entry.path);
    const original = await optional(path.join(directory, migration.backupDirectory, entry.path));
    if (!current || hash(current.raw) !== entry.after || original === null || hash(original) !== entry.before) {
      throw new McpToolError("rollback_unsafe", "State changed after migration; preserve newer state before downgrade");
    }
    originals.push({ path: entry.path, raw: original });
  }
  // A pending marker makes an interrupted restore recover forward to v2.
  await write(path.join(directory, "schema-migration.pending"), "rollback\n", 0o600);
  for (const original of originals) await write(path.join(directory, original.path), original.raw, 0o600);
  await write(path.join(directory, "schema-rollback.json"), body(migration), 0o600);
  await removeDurably(path.join(directory, "schema-migration.json"));
  await removeDurably(path.join(directory, "schema-migration.pending"));
}
