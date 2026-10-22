import { createHmac, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { tokensEqual } from "./auth.js";
import { syncDirectory } from "./continuity/storage-durability.js";
import { McpToolError } from "./errors.js";

const recordSchema = z.object({
  id: z.uuid(), requestId: z.uuid(), owner: z.string().min(1), inputDigest: z.string(),
  // workspaceId is the continuity binding; cwd is the independently resolved Kernel path.
  taskId: z.uuid(), workspaceId: z.string(), cwd: z.string(), reason: z.string().min(1).max(2048),
  operation: z.literal("kernel_identity_adopt"), sourceProjectId: z.string(), legacyProjectId: z.string(),
  kernelHome: z.string(), kernelCli: z.string(), kernelDigest: z.string(), identityDigest: z.string(),
  viewToken: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  status: z.enum(["pending", "approved", "denied", "executing", "succeeded", "unknown"]),
  approvalRef: z.string().optional(), approvedAt: z.iso.datetime().optional(),
  decidedBy: z.literal("operator-key-holder").optional(),
  operationId: z.uuid().optional(), sessionId: z.string().optional(),
  finishedAt: z.iso.datetime().optional(), result: z.record(z.string(), z.unknown()).optional(),
}).strict();
const stateSchema = z.object({ schemaVersion: z.literal(1), records: z.array(recordSchema).max(1000) }).strict();
export type ApprovalRecord = z.infer<typeof recordSchema>;
type State = z.infer<typeof stateSchema>;

/** One bounded ledger, atomic replacement, signed payload, and an exclusive writer.
 * Any uncertain write disables this instance until it is restarted and inspected. */
export class OperatorApprovalStore {
  private state: State = { schemaVersion: 1, records: [] };
  private queue: Promise<unknown> = Promise.resolve();
  private initialized = false;
  private broken = false;
  private lock: Awaited<ReturnType<typeof open>> | undefined;
  private readonly file: string;

  constructor(readonly directory: string, private readonly key: string) {
    this.file = path.join(directory, "ledger.json");
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lockFile = path.join(this.directory, "writer.lock");
    try {
      this.lock = await open(lockFile, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Never steal a live or unreadable lock. Dead PIDs are reclaimed on startup only.
      const pid = Number(await readFile(lockFile, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Operator approval writer lock requires offline inspection");
      try { process.kill(pid, 0); throw new Error("Operator approval store already has a writer"); }
      catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe; }
      await unlink(lockFile);
      this.lock = await open(lockFile, "wx", 0o600);
    }
    try {
      await this.lock.writeFile(String(process.pid));
      await this.lock.sync();
      let raw: string | undefined;
      try { raw = await readFile(this.file, "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (raw !== undefined) {
        if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw new Error("Operator approval ledger exceeds budget");
        const envelope = JSON.parse(raw) as { payload: unknown; signature: string };
        if (typeof envelope.signature !== "string" || !tokensEqual(envelope.signature, this.signature(envelope.payload))) {
          throw new Error("Operator approval ledger signature is invalid");
        }
        this.state = stateSchema.parse(envelope.payload);
        const ids = new Set<string>();
        for (const record of this.state.records) {
          if (ids.has(record.id)) throw new Error("Duplicate approval identity");
          ids.add(record.id);
          if (record.status === "executing") {
            record.status = "unknown";
            record.result = { code: "execution_interrupted", nextAction: "Inspect Kernel identity status; do not retry automatically" };
          }
        }
        await this.persist(this.state);
      }
      this.initialized = true;
    } catch (error) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(lockFile);
      throw error;
    }
  }

  async read<T>(reader: (records: ApprovalRecord[]) => T): Promise<T> {
    await this.queue;
    this.assertAvailable();
    return reader(structuredClone(this.state.records));
  }

  async mutate<T>(mutation: (records: ApprovalRecord[]) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      this.assertAvailable();
      const next = structuredClone(this.state);
      const result = mutation(next.records);
      stateSchema.parse(next);
      try { await this.persist(next); }
      catch { this.broken = true; throw new McpToolError("persistence_unavailable", "Approval state could not be persisted; execution is blocked"); }
      this.state = next;
      return structuredClone(result);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.lock) {
      await this.lock.close();
      this.lock = undefined;
      await unlink(path.join(this.directory, "writer.lock"));
    }
    this.initialized = false;
  }

  private assertAvailable(): void {
    if (!this.initialized || this.broken) throw new McpToolError("persistence_unavailable", "Approval store is unavailable");
  }

  private signature(payload: unknown): string {
    return createHmac("sha256", this.key).update("moonremote-approval-ledger-v1\0").update(JSON.stringify(payload)).digest("hex");
  }

  private async persist(payload: State): Promise<void> {
    const body = JSON.stringify({ payload, signature: this.signature(payload) });
    if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new McpToolError("storage_full", "Approval ledger is full; archive it offline before accepting new requests");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(body); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, this.file);
    await syncDirectory(this.directory);
  }
}
