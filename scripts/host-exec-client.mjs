import { appendFileSync, existsSync } from "node:fs";
import { open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const jobDir = process.argv[2];
if (!jobDir) {
  process.stderr.write("host-exec-client: missing job directory\n");
  process.exit(125);
}

const clientFile = path.join(jobDir, "client.json");
const controlFile = path.join(jobDir, "control.json");
const stdinFile = path.join(jobDir, "stdin.ndjson");
const stdoutFile = path.join(jobDir, "stdout.bin");
const stderrFile = path.join(jobDir, "stderr.bin");
const resultFile = path.join(jobDir, "result.json");
const startedAt = new Date().toISOString();
let stdoutOffset = 0;
let stderrOffset = 0;
let terminating = false;
let terminationSignal = null;

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, filePath);
}

async function heartbeat() {
  try {
    await atomicJson(clientFile, {
      protocolVersion: 1,
      pid: process.pid,
      startedAt,
      lastHeartbeatAt: new Date().toISOString(),
    });
  } catch (error) {
    process.stderr.write(
      `host-exec-client heartbeat failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

function appendInputFrame(value) {
  try {
    appendFileSync(stdinFile, `${JSON.stringify(value)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    process.stderr.write(
      `host-exec-client stdin bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function requestTermination(signal) {
  if (terminating) return;
  terminating = true;
  terminationSignal = signal;
  try {
    await atomicJson(controlFile, {
      action: "terminate",
      signal,
      requestedAt: new Date().toISOString(),
    });
  } catch (error) {
    process.stderr.write(
      `host-exec-client termination bridge failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  setTimeout(() => process.exit(signal === "SIGINT" ? 130 : 143), 4000).unref();
}

process.on("SIGINT", () => { void requestTermination("SIGINT"); });
process.on("SIGTERM", () => { void requestTermination("SIGTERM"); });
process.stdin.on("data", (chunk) =>
  appendInputFrame({ data: Buffer.from(chunk).toString("base64") }),
);
process.stdin.on("end", () => appendInputFrame({ eof: true }));
process.stdin.resume();

async function drain(filePath, target, offset) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return offset;
  }
  let cursor = offset;
  const handle = await open(filePath, "r");
  try {
    while (cursor < info.size) {
      const length = Math.min(64 * 1024, info.size - cursor);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor);
      if (bytesRead <= 0) break;
      target.write(buffer.subarray(0, bytesRead));
      cursor += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return cursor;
}

await heartbeat();
const heartbeatTimer = setInterval(() => { void heartbeat(); }, 1000);
heartbeatTimer.unref();

try {
  for (;;) {
    if (!existsSync(jobDir)) {
      process.stderr.write("host-exec-client: host execution job disappeared\n");
      process.exitCode = 125;
      break;
    }
    stdoutOffset = await drain(stdoutFile, process.stdout, stdoutOffset);
    stderrOffset = await drain(stderrFile, process.stderr, stderrOffset);

    if (existsSync(resultFile)) {
      const result = JSON.parse(await readFile(resultFile, "utf8"));
      stdoutOffset = await drain(stdoutFile, process.stdout, stdoutOffset);
      stderrOffset = await drain(stderrFile, process.stderr, stderrOffset);
      if (result.error) process.stderr.write(`host-executor: ${result.error}\n`);
      if (terminationSignal) {
        process.exitCode = terminationSignal === "SIGINT" ? 130 : 143;
      } else if (Number.isInteger(result.exitCode)) {
        const nativeExitCode = Number(result.exitCode);
        if (nativeExitCode < 0 || nativeExitCode > 255) {
          process.stderr.write(`host-executor: native exit code ${nativeExitCode}\n`);
          process.exitCode = nativeExitCode === 0 ? 0 : 1;
        } else {
          process.exitCode = nativeExitCode;
        }
      } else if (result.signal) {
        process.stderr.write(`host-executor: native process ended by ${result.signal}\n`);
        process.exitCode = 1;
      } else {
        process.exitCode = result.error ? 125 : 0;
      }
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
} catch (error) {
  process.stderr.write(
    `host-exec-client: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 125;
} finally {
  clearInterval(heartbeatTimer);
  process.stdin.pause();
}
