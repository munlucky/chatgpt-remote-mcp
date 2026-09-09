import { AsyncLocalStorage } from "node:async_hooks";
import { appendFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

export interface RequestMetrics {
  setupMs: number | null;
  toolMs: number | null;
  toolError: boolean | null;
}
export const requestMetrics = new AsyncLocalStorage<RequestMetrics>();

const tools = new Set("exec_command run_script write_stdin read_process terminate_process list_processes list_directory stat_path read_file read_files write_file replace_in_file apply_patch upload_file download_file hash_file make_directory copy_path move_path remove_path chmod_path".split(" "));
const methods = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call", "ping"]);
export function safeRpcName(value: unknown, kind: "tool" | "method"): string | null {
  if (typeof value !== "string") return null;
  return (kind === "tool" ? tools : methods).has(value) ? value : "other";
}

export interface UsageEvent {
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

  constructor(
    readonly directory: string | undefined,
    readonly maxBytes = 10 * 1024 * 1024,
    readonly files = 7,
  ) {}

  get pendingEvents(): number {
    return this.#pending;
  }

  record(event: UsageEvent): void {
    if (!this.directory) return;
    if (this.#pending >= MAX_PENDING_EVENTS) {
      this.droppedEvents++;
      return;
    }

    const line = `${JSON.stringify(event)}\n`;
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
      .finally(() => {
        this.#pending = Math.max(0, this.#pending - lines.length);
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
  }
}
