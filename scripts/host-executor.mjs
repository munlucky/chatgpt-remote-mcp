import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const queueDir = argument("--queue");
if (!queueDir) throw new Error("--queue is required");

const jobsDir = path.join(queueDir, "jobs");
const statusFile = path.join(queueDir, "agent.json");
const lockFile = path.join(queueDir, "agent.lock");
const controlFile = path.join(queueDir, "agent.control.json");
const buildId = process.env.MCP_HOST_EXECUTOR_BUILD_ID || "unknown";
const startedAt = new Date().toISOString();
const jobs = new Map();
let stopping = false;
let scanRunning = false;
let lockOwned = false;
let heartbeatRunning = false;

function log(message) {
  try {
    appendFileSync(
      path.join(queueDir, "agent.log"),
      `${new Date().toISOString()} ${message}\n`,
      "utf8",
    );
  } catch {
    // Logging must not interrupt command execution.
  }
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    const deadline = Date.now() + 3000;
    for (;;) {
      try {
        await rename(temporary, filePath);
        break;
      } catch (error) {
        // Windows readers can temporarily prevent replacing an existing file.
        // Keep the same prepared value and never retry the command itself.
        if (process.platform !== "win32" ||
            !["EPERM", "EACCES", "EBUSY"].includes(error?.code) ||
            Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  } finally {
    try { unlinkSync(temporary); } catch { /* renamed or cleanup unavailable */ }
  }
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`, "utf8");
      closeSync(fd);
      lockOwned = true;
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let existingPid = 0;
      try {
        existingPid = Number(readFileSync(lockFile, "utf8").trim());
      } catch {
        // Treat unreadable lock as stale.
      }
      if (processExists(existingPid)) {
        throw new Error(`host executor is already running with pid ${existingPid}`);
      }
      try {
        unlinkSync(lockFile);
      } catch {
        // Retry once.
      }
    }
  }
  throw new Error("failed to acquire host executor lock");
}

function shellInvocation(request) {
  const requested = request.shell?.trim();
  if (process.platform === "win32") {
    const executable = requested || "powershell.exe";
    const base = path.win32.basename(executable).toLowerCase();
    if (
      base === "powershell" ||
      base === "powershell.exe" ||
      base === "pwsh" ||
      base === "pwsh.exe"
    ) {
      return {
        executable,
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request.command],
      };
    }
    if (base === "cmd" || base === "cmd.exe") {
      return { executable, args: ["/d", "/s", "/c", request.command] };
    }
    return {
      executable,
      args: [request.login === false ? "-c" : "-lc", request.command],
    };
  }

  const executable = requested || "/bin/bash";
  return {
    executable,
    args: [request.login === false ? "-c" : "-lc", request.command],
  };
}

function terminatePidTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.unref();
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

function terminateTree(child, signal = "SIGTERM") {
  if (child.pid) terminatePidTree(child.pid, signal);
}

async function closeStream(stream) {
  if (stream.closed || stream.destroyed) return;
  await new Promise((resolve) => {
    stream.once("close", resolve);
    stream.end();
  });
}

async function recoverClaimedJobs() {
  let entries = [];
  try {
    entries = await readdir(jobsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const jobDir = path.join(jobsDir, entry.name);
    const claimed = path.join(jobDir, "request.claimed.json");
    const claimMarker = path.join(jobDir, "claim.json");
    const result = path.join(jobDir, "result.json");
    if ((!existsSync(claimed) && !existsSync(claimMarker)) || existsSync(result)) continue;

    let state;
    try {
      state = JSON.parse(await readFile(path.join(jobDir, "state.json"), "utf8"));
    } catch {
      // A request may have been claimed before a child PID was persisted.
    }
    if (Number.isInteger(state?.pid) && processExists(state.pid)) {
      // A PID can be reused after a crash. It is not proof of process ownership.
      throw new Error(
        `Refusing to terminate unverified live PID ${state.pid} during host executor recovery; inspect the unresolved job before restarting`,
      );
    }

    try { unlinkSync(claimed); } catch { /* already removed after claim */ }
    try { unlinkSync(path.join(jobDir, "stdin.ndjson")); } catch { /* no stdin payload */ }
    await atomicJson(result, {
      exitCode: 125,
      signal: null,
      error: "host executor restarted while this job was in progress; the job was not replayed",
      endedAt: new Date().toISOString(),
    });
  }
}

async function startJob(jobDir) {
  const requestPath = path.join(jobDir, "request.json");
  const claimedPath = path.join(jobDir, "request.claimed.json");

  try {
    await rename(requestPath, claimedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  let request;
  try {
    request = JSON.parse(await readFile(claimedPath, "utf8"));
  } catch (error) {
    try { unlinkSync(claimedPath); } catch { /* best-effort sensitive request cleanup */ }
    await atomicJson(path.join(jobDir, "result.json"), {
      exitCode: 125,
      error: `invalid host request: ${error instanceof Error ? error.message : String(error)}`,
      endedAt: new Date().toISOString(),
    });
    return;
  }

  if (
    request.protocolVersion !== 1 ||
    typeof request.command !== "string" ||
    typeof request.cwd !== "string"
  ) {
    try { unlinkSync(claimedPath); } catch { /* best-effort sensitive request cleanup */ }
    await atomicJson(path.join(jobDir, "result.json"), {
      exitCode: 125,
      error: "unsupported or invalid host request",
      endedAt: new Date().toISOString(),
    });
    return;
  }

  await atomicJson(path.join(jobDir, "claim.json"), {
    protocolVersion: 1,
    jobId: path.basename(jobDir),
    claimedAt: new Date().toISOString(),
  });
  try { unlinkSync(claimedPath); } catch { /* recovery marker is already durable */ }

  const { executable, args } = shellInvocation(request);
  const stdout = createWriteStream(path.join(jobDir, "stdout.bin"), { flags: "a" });
  const stderr = createWriteStream(path.join(jobDir, "stderr.bin"), { flags: "a" });
  let child;

  try {
    child = spawn(executable, args, {
      cwd: request.cwd,
      env: { ...process.env, ...(request.env || {}) },
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    await Promise.all([closeStream(stdout), closeStream(stderr)]);
    await atomicJson(path.join(jobDir, "result.json"), {
      exitCode: 125,
      error: error instanceof Error ? error.message : String(error),
      endedAt: new Date().toISOString(),
    });
    return;
  }

  const runtime = {
    child,
    jobDir,
    stdout,
    stderr,
    stdinOffset: 0,
    stdinRemainder: "",
    stdinEnded: false,
    controlHandled: false,
    lastClientCheckAt: 0,
    finalized: false,
    pollTimer: undefined,
  };
  jobs.set(jobDir, runtime);

  child.stdin.on("error", (error) => {
    // A command may exit without reading its input. A closed pipe belongs to
    // this job and must not terminate the companion or unrelated jobs.
    runtime.stdinEnded = true;
    log(`job ${path.basename(jobDir)} stdin closed: ${error.code || error.message}`);
  });
  child.stdout.pipe(stdout, { end: false });
  child.stderr.pipe(stderr, { end: false });

  const finalize = async (exitCode, signal, error) => {
    if (runtime.finalized) return;
    runtime.finalized = true;
    if (runtime.pollTimer) clearInterval(runtime.pollTimer);
    jobs.delete(jobDir);
    await Promise.all([closeStream(stdout), closeStream(stderr)]);
    await atomicJson(path.join(jobDir, "result.json"), {
      exitCode,
      signal: signal ?? null,
      error: error || undefined,
      endedAt: new Date().toISOString(),
    });
    log(
      `job ${path.basename(jobDir)} ended code=${exitCode ?? "null"} signal=${signal ?? "null"}`,
    );
  };

  child.once("error", (error) => {
    void finalize(125, null, error.message);
  });
  child.once("close", (code, signal) => {
    void finalize(code, signal, undefined);
  });

  // Spawn errors can arrive on the next tick. Observe them before any async I/O.
  await atomicJson(path.join(jobDir, "state.json"), {
    protocolVersion: 1,
    state: "running",
    pid: child.pid ?? null,
    platform: process.platform,
    shell: executable,
    startedAt: new Date().toISOString(),
  });
  log(`job ${path.basename(jobDir)} started pid=${child.pid ?? "unknown"}`);
  if (runtime.finalized) return;

  runtime.pollTimer = setInterval(async () => {
    if (runtime.finalized) return;
    try {
      if (!existsSync(jobDir)) {
        terminateTree(child, "SIGKILL");
        return;
      }

      const controlPath = path.join(jobDir, "control.json");
      if (!runtime.controlHandled && existsSync(controlPath)) {
        runtime.controlHandled = true;
        const control = JSON.parse(await readFile(controlPath, "utf8"));
        if (control.action === "terminate") {
          terminateTree(child, control.signal === "SIGINT" ? "SIGINT" : "SIGTERM");
        }
      }

      const stdinPath = path.join(jobDir, "stdin.ndjson");
      if (!runtime.stdinEnded && existsSync(stdinPath)) {
        const info = await stat(stdinPath);
        if (info.size > runtime.stdinOffset) {
          const handle = await open(stdinPath, "r");
          const length = info.size - runtime.stdinOffset;
          const buffer = Buffer.allocUnsafe(length);
          const { bytesRead } = await handle.read(
            buffer,
            0,
            length,
            runtime.stdinOffset,
          );
          await handle.close();
          runtime.stdinOffset += bytesRead;

          const text =
            runtime.stdinRemainder +
            buffer.subarray(0, bytesRead).toString("utf8");
          const lines = text.split("\n");
          runtime.stdinRemainder = lines.pop() || "";
          for (const line of lines) {
            if (!line) continue;
            const frame = JSON.parse(line);
            if (typeof frame.data === "string") {
              child.stdin.write(Buffer.from(frame.data, "base64"));
            }
            if (frame.eof === true) {
              runtime.stdinEnded = true;
              child.stdin.end();
            }
          }
        }
      }

      const now = Date.now();
      if (now - runtime.lastClientCheckAt >= 1000) {
        runtime.lastClientCheckAt = now;
        let clientHeartbeat = Number.NaN;
        try {
          const client = JSON.parse(
            await readFile(path.join(jobDir, "client.json"), "utf8"),
          );
          clientHeartbeat = Date.parse(client.lastHeartbeatAt);
        } catch {
          // Missing or partial client status is handled as stale below.
        }
        if (
          !Number.isFinite(clientHeartbeat) ||
          now - clientHeartbeat > 15_000
        ) {
          log(
            `job ${path.basename(jobDir)} client heartbeat stale; terminating`,
          );
          terminateTree(child, "SIGKILL");
        }
      }
    } catch (error) {
      log(
        `job ${path.basename(jobDir)} bridge poll error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, 50);
  runtime.pollTimer.unref();
}

async function scan() {
  if (scanRunning || stopping) return;
  scanRunning = true;
  try {
    if (existsSync(controlFile)) {
      let control;
      try {
        control = JSON.parse(await readFile(controlFile, "utf8"));
      } catch {
        control = undefined;
      }
      if (control?.action === "stop") {
        try { unlinkSync(controlFile); } catch { /* already gone */ }
        void shutdown("control");
        return;
      }
    }

    let entries = [];
    try {
      entries = await readdir(jobsDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const jobDir = path.join(jobsDir, entry.name);
      if (
        jobs.has(jobDir) ||
        !existsSync(path.join(jobDir, "request.json")) ||
        !existsSync(path.join(jobDir, "client.json"))
      ) {
        continue;
      }

      let clientFresh = false;
      try {
        const client = JSON.parse(
          await readFile(path.join(jobDir, "client.json"), "utf8"),
        );
        const heartbeat = Date.parse(client.lastHeartbeatAt);
        clientFresh =
          Number.isFinite(heartbeat) && Date.now() - heartbeat <= 5000;
      } catch {
        // Wait for a complete client heartbeat.
      }
      if (clientFresh) await startJob(jobDir);
    }
  } finally {
    scanRunning = false;
  }
}

async function writeHeartbeat() {
  await atomicJson(statusFile, {
    protocolVersion: 1,
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    buildId,
    startedAt,
    lastHeartbeatAt: new Date().toISOString(),
  });
}

async function shutdown(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  log(`agent stopping signal=${signal}`);
  for (const runtime of jobs.values()) {
    terminateTree(runtime.child, "SIGKILL");
  }
  const deadline = Date.now() + 3000;
  while (jobs.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    unlinkSync(statusFile);
  } catch {
    // Already gone.
  }
  if (lockOwned) {
    try {
      unlinkSync(lockFile);
    } catch {
      // Already gone.
    }
  }
  process.exit(exitCode);
}

function backgroundFailure(operation, error) {
  log(`${operation} failed: ${error?.stack || error}`);
  void shutdown(`${operation}-error`, 1);
}

await mkdir(jobsDir, { recursive: true, mode: 0o700 });
acquireLock();
try { unlinkSync(controlFile); } catch { /* no stale control */ }
await recoverClaimedJobs();
await writeHeartbeat();
log(
  `agent started pid=${process.pid} platform=${process.platform} build=${buildId}`,
);
setInterval(() => {
  if (stopping || heartbeatRunning) return;
  heartbeatRunning = true;
  void writeHeartbeat()
    .catch((error) => backgroundFailure("heartbeat", error))
    .finally(() => { heartbeatRunning = false; });
}, 1000);
setInterval(() => {
  void scan().catch((error) => backgroundFailure("scan", error));
}, 50);
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await new Promise(() => {});
