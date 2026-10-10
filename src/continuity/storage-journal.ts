import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { McpToolError } from "../errors.js";
import { parseExecution, parseWorkspace } from "./storage-schema.js";
import { removeDurably, syncDirectory, syncFileAndParents } from "./storage-durability.js";
import type { ExecutionRecord, WorkspaceState } from "./task-types.js";

type AtomicWrite = (file: string, body: string, mode: number) => Promise<void>;
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");
const body = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z.strictObject({
  schemaVersion: z.literal(1), transactionId: z.string().uuid(), workspaceId: z.string().regex(/^[a-f0-9]{32}$/),
  records: z.array(z.strictObject({
    path: z.string().regex(/^(state\.json|executions\/[0-9a-fA-F-]{36}\.json)$/),
    before: digest, after: digest, body: z.string(),
  })).min(1).max(51),
});
type Journal = z.infer<typeof journalSchema>;

function validate(journal: Journal, workspaceId: string): void {
  if (journal.workspaceId !== workspaceId || new Set(journal.records.map((record) => record.path)).size !== journal.records.length) {
    throw new McpToolError("state_corrupt", "Journal ownership mismatch");
  }
  const snapshot = journal.records.find((record) => record.path === "state.json");
  if (!snapshot || journal.records.at(-1) !== snapshot) throw new McpToolError("state_corrupt", "Journal snapshot is missing or out of order");
  const state = parseWorkspace(snapshot.body, "transaction snapshot");
  const records = journal.records.filter((record) => record !== snapshot).map((entry) => {
    const record = parseExecution(entry.body, "transaction receipt");
    if (entry.path !== `executions/${record.operationId}.json`) throw new McpToolError("state_corrupt", "Journal receipt path mismatch");
    return record;
  });
  if (state.workspace.workspaceId !== workspaceId) throw new McpToolError("state_corrupt", "Journal workspace mismatch");
  // Reconciliations can reference unchanged receipts. Validate updated owners here;
  // the complete set is checked by TaskStore before preparing the transaction.
  for (const record of records) {
    if (record.workspaceId !== workspaceId || !Object.hasOwn(state.tasks, record.taskId)) throw new McpToolError("state_corrupt", "Journal task owner mismatch");
  }
  for (const record of journal.records) if (hash(record.body) !== record.after) throw new McpToolError("state_corrupt", "Journal result digest mismatch");
}

export async function prepareJournal(directory: string, state: WorkspaceState, records: ExecutionRecord[]): Promise<Journal> {
  const entries = [
    ...records.map((record) => ({ path: `executions/${record.operationId}.json`, body: body(record) })),
    { path: "state.json", body: body(state) },
  ];
  const journal: Journal = { schemaVersion: 1, transactionId: randomUUID(), workspaceId: state.workspace.workspaceId, records: [] };
  for (const entry of entries) {
    journal.records.push({ ...entry, before: hash(await readFile(path.join(directory, entry.path), "utf8")), after: hash(entry.body) });
  }
  validate(journalSchema.parse(journal), state.workspace.workspaceId);
  return journal;
}

async function apply(directory: string, journal: Journal, write: AtomicWrite): Promise<void> {
  // Check all records first. A committed transaction must never overwrite a
  // record changed outside the transaction, or a newer request result.
  for (const record of journal.records) {
    const current = hash(await readFile(path.join(directory, record.path), "utf8"));
    if (current !== record.before && current !== record.after) throw new McpToolError("state_corrupt", "Committed journal conflicts with current state");
  }
  for (const record of journal.records) {
    if (hash(await readFile(path.join(directory, record.path), "utf8")) !== record.after) {
      await write(path.join(directory, record.path), record.body, 0o600);
    }
    // A previous rename may have succeeded before its directory sync failed.
    // Confirm durability even when matching bytes make a rewrite unnecessary.
    await syncFileAndParents(path.join(directory, record.path), directory);
  }
}

export async function commitJournal(directory: string, journal: Journal, write: AtomicWrite): Promise<void> {
  validate(journal, journal.workspaceId);
  const file = path.join(directory, "transactions", `${journal.transactionId}.json`);
  const serialized = body(journal);
  await write(file, serialized, 0o600);
  // The marker is the commit decision. Recovery only copies saved metadata;
  // it never spawns a command or applies an external effect.
  await write(`${file}.commit`, `${hash(serialized)}\n`, 0o600);
  await syncFileAndParents(file, directory);
  await syncFileAndParents(`${file}.commit`, directory);
  await apply(directory, journal, write);
  // Remove the payload first: an orphan marker cannot replay stale data.
  await removeDurably(file);
  await removeDurably(`${file}.commit`);
}

export async function recoverJournals(directory: string, workspaceId: string, write: AtomicWrite): Promise<void> {
  const journalDirectory = path.join(directory, "transactions");
  let entries;
  try { entries = await readdir(journalDirectory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(journalDirectory, entry.name);
    const raw = await readFile(file, "utf8");
    let marker: string;
    try { marker = await readFile(`${file}.commit`, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await removeDurably(file); // Prepared only: no target has been written.
      continue;
    }
    let journal: Journal;
    try { journal = journalSchema.parse(JSON.parse(raw)); }
    catch { throw new McpToolError("state_corrupt", "Invalid committed continuity journal"); }
    if (entry.name !== `${journal.transactionId}.json` || marker !== `${hash(raw)}\n`) throw new McpToolError("state_corrupt", "Journal commit integrity check failed");
    validate(journal, workspaceId);
    // A visible marker can come from a rename whose directory sync failed.
    // Persist both the payload and decision before touching any target.
    await syncFileAndParents(file, directory);
    await syncFileAndParents(`${file}.commit`, directory);
    await apply(directory, journal, write);
    await removeDurably(file);
    await removeDurably(`${file}.commit`);
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json.commit")) continue;
    const marker = path.join(journalDirectory, entry.name);
    try { await readFile(marker.slice(0, -7)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") await removeDurably(marker); else throw error; }
  }
  // Also complete any deletion whose prior directory sync failed.
  await syncDirectory(journalDirectory);
}

export function journalBytes(journal: Journal): number {
  return Buffer.byteLength(body(journal)) + 65;
}
