import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { open, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { McpToolError } from "../errors.js";
import {
  CONTINUITY_SCHEMA_VERSION,
  type ContinuityHealth,
  type ExecutionRecord,
  type WorkspaceIdentityRecord,
  type WorkspaceState,
} from "./task-types.js";

export interface TaskStoreOptions {
  stateDirectory: string;
  maxSnapshotBytes: number;
  maxTotalBytes: number;
}

interface LockRecord {
  pid: number;
  ownerId: string;
  acquiredAt: string;
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }
  return value;
}

function parseState(raw: string, file: string): WorkspaceState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpToolError("state_corrupt", `Continuity state is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new McpToolError("state_corrupt", `Continuity state has an invalid shape: ${file}`);
  }
  const schemaVersion = (parsed as { schemaVersion?: unknown }).schemaVersion;
  if (schemaVersion !== CONTINUITY_SCHEMA_VERSION) {
    throw new McpToolError(
      "unsupported_schema",
      `Unsupported continuity schema version ${String(schemaVersion)} in ${file}`,
    );
  }
  const state = parsed as WorkspaceState;
  if (!state.workspace?.workspaceId || !state.tasks || !state.mutationDedupe) {
    throw new McpToolError("state_corrupt", `Continuity state is missing required fields: ${file}`);
  }
  return state;
}

function parseExecution(raw: string, file: string): ExecutionRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new McpToolError("state_corrupt", `Execution record is not valid JSON: ${file}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new McpToolError("state_corrupt", `Execution record has an invalid shape: ${file}`);
  }
  const record = parsed as ExecutionRecord;
  if (record.schemaVersion !== CONTINUITY_SCHEMA_VERSION) {
    throw new McpToolError(
      "unsupported_schema",
      `Unsupported execution schema version ${String(record.schemaVersion)} in ${file}`,
    );
  }
  if (!record.operationId || !record.taskId || !record.workspaceId) {
    throw new McpToolError("state_corrupt", `Execution record is missing required fields: ${file}`);
  }
  return record;
}

export class TaskStore {
  readonly #options: TaskStoreOptions;
  readonly #bootId = randomUUID();
  readonly #ownerId = randomUUID();
  readonly #workspaceQueues = new Map<string, Promise<void>>();
  readonly #executionQueues = new Map<string, Promise<void>>();
  #initialized = false;
  #initializing: Promise<void> | undefined;
  #writerGuardHeld = false;
  #installationId: string | undefined;
  #hmacKey: Buffer | undefined;
  #failedWrites = 0;
  #pendingWrites = 0;
  #bytesUsed = 0;

  constructor(options: TaskStoreOptions) {
    this.#options = options;
  }

  get bootId(): string {
    return this.#bootId;
  }

  get installationId(): string {
    if (!this.#installationId) {
      throw new Error("TaskStore is not initialized");
    }
    return this.#installationId;
  }

  async initialize(): Promise<void> {
    if (this.#initialized) return;
    if (this.#initializing) return this.#initializing;
    const initializing = (async () => {
      await mkdir(this.#options.stateDirectory, { recursive: true, mode: 0o700 });
      await this.#acquireWriterGuard();
      try {
        this.#installationId = await this.#loadOrCreateInstallationId();
        this.#hmacKey = await this.#loadOrCreateHmacKey();
        await mkdir(this.#workspacesDirectory(), { recursive: true, mode: 0o700 });
        this.#bytesUsed = await this.#measureBytes(this.#options.stateDirectory);
        await this.#recoverPreviousBootExecutions();
        this.#initialized = true;
      } catch (error) {
        await this.close().catch(() => undefined);
        throw error;
      }
    })();
    this.#initializing = initializing;
    try {
      await initializing;
    } finally {
      if (this.#initializing === initializing) this.#initializing = undefined;
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#workspaceQueues.values(), ...this.#executionQueues.values()]);
    if (this.#writerGuardHeld) {
      const lockPath = this.#lockPath();
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord;
        if (current.ownerId === this.#ownerId) {
          await unlink(lockPath).catch((error) => {
            if (!isErrno(error, "ENOENT")) throw error;
          });
        }
      } catch (error) {
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    this.#writerGuardHeld = false;
    this.#initialized = false;
  }

  async inputHmac(value: unknown): Promise<string> {
    await this.initialize();
    return createHmac("sha256", this.#hmacKey!)
      .update(JSON.stringify(stableValue(value)))
      .digest("hex");
  }

  async withWorkspaceLock<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    return this.#serialize(this.#workspaceQueues, workspaceId, operation);
  }

  async withExecutionLock<T>(operationId: string, operation: () => Promise<T>): Promise<T> {
    await this.initialize();
    return this.#serialize(this.#executionQueues, operationId, operation);
  }

  async readWorkspace(identity: WorkspaceIdentityRecord): Promise<WorkspaceState> {
    await this.initialize();
    const file = this.#statePath(identity.workspaceId);
    try {
      const state = parseState(await readFile(file, "utf8"), file);
      if (state.workspace.workspaceId !== identity.workspaceId) {
        throw new McpToolError("workspace_mismatch", "Stored workspace identity does not match requested workspace");
      }
      return state;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      return {
        schemaVersion: CONTINUITY_SCHEMA_VERSION,
        workspace: identity,
        workspaceRevision: 0,
        activeTaskId: null,
        tasks: {},
        mutationDedupe: {},
      };
    }
  }

  async writeWorkspace(state: WorkspaceState): Promise<void> {
    await this.initialize();
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(body) > this.#options.maxSnapshotBytes) {
      throw new McpToolError(
        "storage_full",
        `Workspace continuity snapshot exceeds ${this.#options.maxSnapshotBytes} bytes`,
      );
    }
    const directory = this.#workspaceDirectory(state.workspace.workspaceId);
    await mkdir(path.join(directory, "executions"), { recursive: true, mode: 0o700 });
    await this.#atomicWrite(this.#statePath(state.workspace.workspaceId), body, 0o600);
  }

  async findTask(taskId: string): Promise<{ state: WorkspaceState; taskId: string } | null> {
    await this.initialize();
    for (const workspaceId of await this.#workspaceIds()) {
      const file = this.#statePath(workspaceId);
      try {
        const state = parseState(await readFile(file, "utf8"), file);
        if (state.tasks[taskId]) return { state, taskId };
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
    }
    return null;
  }

  async activeCandidates(limit: number): Promise<{
    candidates: Array<{ workspace: WorkspaceIdentityRecord; taskId: string; objective: string; revision: number; updatedAt: string }>;
    complete: boolean;
  }> {
    await this.initialize();
    const candidates: Array<{ workspace: WorkspaceIdentityRecord; taskId: string; objective: string; revision: number; updatedAt: string }> = [];
    const workspaceIds = await this.#workspaceIds();
    for (const workspaceId of workspaceIds) {
      const file = this.#statePath(workspaceId);
      const state = parseState(await readFile(file, "utf8"), file);
      if (!state.activeTaskId) continue;
      const task = state.tasks[state.activeTaskId];
      if (!task || task.status !== "active") continue;
      candidates.push({
        workspace: state.workspace,
        taskId: task.taskId,
        objective: task.objective,
        revision: task.revision,
        updatedAt: task.updatedAt,
      });
      if (candidates.length >= limit) {
        return { candidates, complete: workspaceIds.length <= limit };
      }
    }
    return { candidates, complete: true };
  }

  async readExecution(workspaceId: string, operationId: string): Promise<ExecutionRecord | null> {
    await this.initialize();
    const file = this.#executionPath(workspaceId, operationId);
    try {
      return parseExecution(await readFile(file, "utf8"), file);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return null;
      throw error;
    }
  }

  async writeExecution(record: ExecutionRecord): Promise<void> {
    await this.initialize();
    const directory = path.dirname(this.#executionPath(record.workspaceId, record.operationId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.#atomicWrite(
      this.#executionPath(record.workspaceId, record.operationId),
      `${JSON.stringify(record, null, 2)}\n`,
      0o600,
    );
  }

  async listExecutions(workspaceId: string, taskId: string): Promise<ExecutionRecord[]> {
    await this.initialize();
    const directory = path.join(this.#workspaceDirectory(workspaceId), "executions");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const records: ExecutionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const file = path.join(directory, entry.name);
      const record = parseExecution(await readFile(file, "utf8"), file);
      if (record.taskId === taskId) records.push(record);
    }
    records.sort((a, b) => b.preparedAt.localeCompare(a.preparedAt));
    return records;
  }

  async health(): Promise<ContinuityHealth> {
    await this.initialize();
    let unknownExecutions = 0;
    for (const workspaceId of await this.#workspaceIds()) {
      const directory = path.join(this.#workspaceDirectory(workspaceId), "executions");
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const record = parseExecution(await readFile(path.join(directory, entry.name), "utf8"), path.join(directory, entry.name));
        if (record.state === "unknown") unknownExecutions += 1;
      }
    }
    this.#bytesUsed = await this.#measureBytes(this.#options.stateDirectory);
    return {
      schemaVersion: CONTINUITY_SCHEMA_VERSION,
      stateDirectory: this.#options.stateDirectory,
      initialized: this.#initialized,
      writerGuardHeld: this.#writerGuardHeld,
      pendingWrites: this.#pendingWrites,
      failedWrites: this.#failedWrites,
      unknownExecutions,
      bytesUsed: this.#bytesUsed,
    };
  }

  async #serialize<T>(
    queues: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    queues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (queues.get(key) === queued) queues.delete(key);
    }
  }

  async #loadOrCreateInstallationId(): Promise<string> {
    const file = path.join(this.#options.stateDirectory, "installation.json");
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as { installationId?: unknown; schemaVersion?: unknown };
      if (parsed.schemaVersion !== CONTINUITY_SCHEMA_VERSION || typeof parsed.installationId !== "string") {
        throw new McpToolError("state_corrupt", "Invalid continuity installation metadata");
      }
      return parsed.installationId;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const installationId = randomUUID();
      await this.#atomicWrite(
        file,
        `${JSON.stringify({ schemaVersion: CONTINUITY_SCHEMA_VERSION, installationId }, null, 2)}\n`,
        0o600,
      );
      return installationId;
    }
  }

  async #loadOrCreateHmacKey(): Promise<Buffer> {
    const file = path.join(this.#options.stateDirectory, "hmac.key");
    try {
      const key = await readFile(file);
      if (key.length < 32) throw new McpToolError("state_corrupt", "Continuity HMAC key is invalid");
      return key;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
      const key = randomBytes(32);
      await writeFile(file, key, { mode: 0o600, flag: "wx" });
      return key;
    }
  }

  async #acquireWriterGuard(): Promise<void> {
    const file = this.#lockPath();
    const payload: LockRecord = { pid: process.pid, ownerId: this.#ownerId, acquiredAt: new Date().toISOString() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(file, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(payload)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.#writerGuardHeld = true;
        return;
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        let current: LockRecord;
        try {
          current = JSON.parse(await readFile(file, "utf8")) as LockRecord;
        } catch {
          throw new McpToolError("persistence_unavailable", "Continuity writer lock exists but cannot be validated");
        }
        let ownerAlive = false;
        try {
          process.kill(current.pid, 0);
          ownerAlive = true;
        } catch (probeError) {
          ownerAlive = !isErrno(probeError, "ESRCH");
        }
        if (ownerAlive) {
          throw new McpToolError(
            "persistence_unavailable",
            `Continuity state is already owned by writer pid ${current.pid}`,
          );
        }
        await unlink(file);
      }
    }
    throw new McpToolError("persistence_unavailable", "Unable to acquire continuity writer guard");
  }

  async #recoverPreviousBootExecutions(): Promise<void> {
    for (const workspaceId of await this.#workspaceIds()) {
      const directory = path.join(this.#workspaceDirectory(workspaceId), "executions");
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const file = path.join(directory, entry.name);
        const record = parseExecution(await readFile(file, "utf8"), file);
        if ((record.state === "prepared" || record.state === "running") && record.bootId !== this.#bootId) {
          record.state = "unknown";
          record.endedAt = record.endedAt ?? new Date().toISOString();
          record.errorCode = record.errorCode ?? "previous_boot_unsettled";
          await this.#atomicWrite(file, `${JSON.stringify(record, null, 2)}\n`, 0o600);
        }
      }
    }
  }

  async #atomicWrite(file: string, body: string, mode: number): Promise<void> {
    const bytes = Buffer.byteLength(body);
    let previousBytes = 0;
    try {
      previousBytes = (await stat(file)).size;
    } catch (error) {
      if (!isErrno(error, "ENOENT")) throw error;
    }
    if (this.#bytesUsed - previousBytes + bytes > this.#options.maxTotalBytes) {
      throw new McpToolError("storage_full", "Continuity storage budget is exhausted");
    }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    this.#pendingWrites += 1;
    try {
      const handle = await open(temporary, "wx", mode);
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, file);
      try {
        const directoryHandle = await open(path.dirname(file), "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      } catch {
        // Directory fsync is not uniformly supported. File fsync + rename remains the minimum contract.
      }
      this.#bytesUsed = Math.max(0, this.#bytesUsed - previousBytes + bytes);
    } catch (error) {
      this.#failedWrites += 1;
      await rm(temporary, { force: true }).catch(() => undefined);
      if (isErrno(error, "ENOSPC")) {
        throw new McpToolError("storage_full", "Continuity storage device is full");
      }
      if (isErrno(error, "EACCES") || isErrno(error, "EPERM")) {
        throw new McpToolError("persistence_unavailable", "Continuity state directory is not writable");
      }
      throw error;
    } finally {
      this.#pendingWrites = Math.max(0, this.#pendingWrites - 1);
    }
  }

  async #measureBytes(root: string): Promise<number> {
    let total = 0;
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return 0;
      throw error;
    }
    for (const entry of entries) {
      const child = path.join(root, entry.name);
      if (entry.isDirectory()) total += await this.#measureBytes(child);
      else if (entry.isFile()) total += (await stat(child)).size;
    }
    return total;
  }

  async #workspaceIds(): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(this.#workspacesDirectory(), { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  #workspacesDirectory(): string {
    return path.join(this.#options.stateDirectory, "workspaces");
  }

  #workspaceDirectory(workspaceId: string): string {
    if (!/^[a-f0-9]{32}$/.test(workspaceId)) {
      throw new McpToolError("workspace_mismatch", "Invalid workspace ID");
    }
    return path.join(this.#workspacesDirectory(), workspaceId);
  }

  #statePath(workspaceId: string): string {
    return path.join(this.#workspaceDirectory(workspaceId), "state.json");
  }

  #executionPath(workspaceId: string, operationId: string): string {
    if (!/^[0-9a-fA-F-]{36}$/.test(operationId)) {
      throw new McpToolError("idempotency_conflict", "Invalid operation ID");
    }
    return path.join(this.#workspaceDirectory(workspaceId), "executions", `${operationId}.json`);
  }

  #lockPath(): string {
    return path.join(this.#options.stateDirectory, "writer.lock");
  }
}
