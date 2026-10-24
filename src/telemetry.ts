import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Correlation } from "./telemetry-correlation.js";
import { serializeUsageEvent } from "./telemetry-schema.js";

export interface RequestMetrics {
  correlation?: Correlation;
  processRead?: { running: boolean; hasMore: boolean; outputBytes: number; droppedOutputBytes: number };
  clientClass?: "codex" | "openai_mcp" | "other";
  requestId?: string;
  trafficClass?: "probe" | "usage";
  toolName?: string | null;
  errorCategory?: "file_missing" | "permission_denied" | "tool_failure";
  errorCode?: string;
  setupMs: number | null;
  toolMs: number | null;
  toolError: boolean | null;
}
export const requestMetrics = new AsyncLocalStorage<RequestMetrics>();

export { safeRpcName } from "./telemetry-schema.js";

export interface UsageEvent {
  schemaVersion?: number;
  bootId?: string;
  correlation?: Correlation;
  processRead?: RequestMetrics["processRead"];
  event: "mcp_request";
  timestamp: string;
  requestId: string;
  buildId: string;
  httpMethod: string;
  rpcMethod: string | null;
  toolName: string | null;
  status: number;
  outcome: "completed" | "aborted";
  durationMs: number;
  setupMs: number | null;
  toolMs: number | null;
  toolError: boolean | null;
  responseBytes: number | null;
  trafficClass?: "probe" | "usage";
  errorCategory?: RequestMetrics["errorCategory"];
  errorCode?: string;
  protocolHeader?: "supported" | "unsupported" | "omitted";
  protocolVersion?: string;
  initializeProtocol?: "supported" | "unsupported" | "omitted";
  clientClass?: RequestMetrics["clientClass"];
}

export interface ProcessUsageEvent {
  schemaVersion?: number;
  correlation?: Correlation;
  event: "process_terminal";
  timestamp: string;
  requestId: string;
  buildId: string;
  bootId: string;
  clientClass?: RequestMetrics["clientClass"];
  trafficClass: "probe" | "usage";
  toolName: "exec_command" | "run_script";
  sessionId: string;
  startedAt: string;
  endedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutMs?: number;
  spawnFailed: boolean;
  totalOutputBytes: number;
  errorCode: string | null;
}

export interface ProcessStartedEvent {
  schemaVersion?: number;
  correlation?: Correlation;
  event: "process_started";
  timestamp: string;
  requestId: string;
  buildId: string;
  bootId: string;
  clientClass?: RequestMetrics["clientClass"];
  trafficClass: "probe" | "usage";
  toolName: "exec_command" | "run_script";
  sessionId: string;
  startedAt: string;
  timeoutMs?: number;
}

const MAX_PENDING_EVENTS = 1000;
const BATCH_EVENT_LIMIT = 100;
const BATCH_BYTE_LIMIT = 64 * 1024;
const BATCH_DELAY_MS = 100;

// Bounded in-memory batching keeps serialization and disk I/O off the request
// completion path. Files contain only the fixed metadata schema, never bodies.
export class UsageLog {
  #queue: Promise<void> = Promise.resolve();
  #buffer: string[] = [];
  #bufferBytes = 0;
  #pending = 0;
  #size = 0;
  #initialized = false;
  #flushTimer: NodeJS.Timeout | undefined;
  droppedEvents = 0;
  writeFailures = 0;
  #observation?: { bootId: string; buildId: string; since: string };

  constructor(
    readonly directory: string | undefined,
    readonly maxBytes = 10 * 1024 * 1024,
    readonly files = 7,
  ) {}

  startObservation(bootId: string, buildId: string): void {
    this.#observation = { bootId, buildId, since: new Date().toISOString() };
  }

  async snapshot(): Promise<void> {
    if (!this.directory || !this.#observation) return;
    const file = path.join(this.directory, `diagnostics-${this.#observation.bootId}.json`);
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(`${file}.tmp`, JSON.stringify({ schemaVersion: 2, ...this.#observation,
        until: new Date().toISOString(), pendingEvents: this.#pending,
        droppedEvents: this.droppedEvents, writeFailures: this.writeFailures }), { mode: 0o600 });
      await rename(`${file}.tmp`, file);
    } catch { /* Missing independent diagnostic evidence is unknown, never zero loss. */ }
  }

  get pendingEvents(): number {
    return this.#pending;
  }

  record(event: UsageEvent | ProcessUsageEvent | ProcessStartedEvent): void {
    if (!this.directory) return;
    if (this.#pending >= MAX_PENDING_EVENTS) {
      this.droppedEvents++;
      return;
    }

    const line = `${JSON.stringify(serializeUsageEvent(event))}\n`;
    this.#buffer.push(line);
    this.#bufferBytes += Buffer.byteLength(line);
    this.#pending++;

    if (
      this.#buffer.length >= BATCH_EVENT_LIMIT ||
      this.#bufferBytes >= BATCH_BYTE_LIMIT
    ) {
      this.#enqueueBuffered();
      return;
    }
    if (!this.#flushTimer) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = undefined;
        this.#enqueueBuffered();
      }, BATCH_DELAY_MS);
      this.#flushTimer.unref();
    }
  }

  #enqueueBuffered(): void {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = undefined;
    }
    if (this.#buffer.length === 0) return;

    const lines = this.#buffer;
    this.#buffer = [];
    this.#bufferBytes = 0;
    this.#queue = this.#queue
      .then(() => this.#writeLines(lines))
      .catch(() => {
        this.writeFailures++;
        this.#initialized = false;
      })
      .finally(async () => {
        this.#pending = Math.max(0, this.#pending - lines.length);
        await this.snapshot();
      });
  }

  async #initialize(file: string): Promise<void> {
    if (this.#initialized) return;
    await mkdir(this.directory!, { recursive: true, mode: 0o700 });
    this.#size = await stat(file)
      .then((entry) => entry.size)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return 0;
      });
    this.#initialized = true;
  }

  async #rotate(file: string): Promise<void> {
    for (let index = this.files - 1; index >= 0; index -= 1) {
      const source = index === 0 ? file : `${file}.${index}`;
      try {
        if (index === this.files - 1) await unlink(source);
        else await rename(source, `${file}.${index + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    this.#size = 0;
  }

  async #writeLines(lines: string[]): Promise<void> {
    const file = path.join(this.directory!, "requests.jsonl");
    await this.#initialize(file);

    let index = 0;
    while (index < lines.length) {
      const firstBytes = Buffer.byteLength(lines[index]!);
      if (this.#size > 0 && this.#size + firstBytes > this.maxBytes) {
        await this.#rotate(file);
      }

      const batch: string[] = [];
      let batchBytes = 0;
      while (index < lines.length) {
        const line = lines[index]!;
        const lineBytes = Buffer.byteLength(line);
        if (
          batch.length > 0 &&
          this.#size + batchBytes + lineBytes > this.maxBytes
        ) {
          break;
        }
        batch.push(line);
        batchBytes += lineBytes;
        index += 1;
        if (this.#size + batchBytes >= this.maxBytes) break;
      }

      await appendFile(file, batch.join(""), { mode: 0o600 });
      this.#size += batchBytes;
      if (index < lines.length && this.#size >= this.maxBytes) {
        await this.#rotate(file);
      }
    }
  }

  async flush(): Promise<void> {
    this.#enqueueBuffered();
    await this.#queue;
    await this.snapshot();
  }
}
