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

// Bounded async writes keep disk latency off the request completion path.
// Files contain only the fixed metadata schema, never request/response bodies.
export class UsageLog {
  #queue: Promise<void> = Promise.resolve();
  #pending = 0;
  #size = 0;
  #initialized = false;
  droppedEvents = 0;
  writeFailures = 0;
  constructor(readonly directory: string | undefined, readonly maxBytes = 10 * 1024 * 1024, readonly files = 7) {}

  record(event: UsageEvent): void {
    if (!this.directory) return;
    if (this.#pending >= 1000) { this.droppedEvents++; return; }
    this.#pending++;
    const line = `${JSON.stringify(event)}\n`;
    this.#queue = this.#queue.then(async () => {
      const file = path.join(this.directory!, "requests.jsonl");
      if (!this.#initialized) {
        await mkdir(this.directory!, { recursive: true, mode: 0o700 });
        this.#size = await stat(file).then(s => s.size).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return 0;
        });
        this.#initialized = true;
      }
      if (this.#size + Buffer.byteLength(line) > this.maxBytes) {
        for (let i = this.files - 1; i >= 0; i--) {
          const source = i === 0 ? file : `${file}.${i}`;
          try {
            if (i === this.files - 1) await unlink(source);
            else await rename(source, `${file}.${i + 1}`);
          } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
        }
        this.#size = 0;
      }
      await appendFile(file, line, { mode: 0o600 });
      this.#size += Buffer.byteLength(line);
    }).catch(() => {
      this.writeFailures++;
      this.#initialized = false;
    }).finally(() => { this.#pending--; });
  }
  async flush(): Promise<void> { await this.#queue; }
}
