// Manage the existing companion on a POSIX host. No shell evaluates .env.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const action = process.argv[2] || "status";
if (!["start", "stop", "status"].includes(action) || process.platform === "win32") {
  throw new Error("Usage on a POSIX host: node scripts/host-executor-posix.mjs start|stop|status");
}
const settings = parseEnv(await readFile(path.join(project, ".env"), "utf8"));
const shared = settings.SHARED_PATH;
if (!shared || !path.isAbsolute(shared)) throw new Error("SHARED_PATH must be an absolute host path");
if (settings.MCP_HOST_EXECUTOR_QUEUE_DIR && settings.MCP_HOST_EXECUTOR_QUEUE_DIR !== "/shared/.chatgpt-remote-mcp-host-exec") {
  throw new Error("The POSIX manager requires the default container queue path");
}
const queue = path.join(shared, ".chatgpt-remote-mcp-host-exec");
const statusPath = path.join(queue, "agent.json");
const maxAge = Number(settings.MCP_HOST_EXECUTOR_HEARTBEAT_MAX_AGE_MS || 5000);
if (!Number.isFinite(maxAge) || maxAge <= 0) throw new Error("Invalid heartbeat maximum age");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function status() {
  try { return JSON.parse(await readFile(statusPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function fresh(s) {
  const age = Date.now() - Date.parse(s?.lastHeartbeatAt);
  return s?.protocolVersion === 1 && Number.isInteger(s.pid) && s.pid > 0 &&
    Number.isFinite(age) && age >= 0 && age <= maxAge;
}
async function controlStop() {
  const target = path.join(queue, "agent.control.json");
  const temporary = target + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify({ action: "stop", requestedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  await rename(temporary, target);
}
if (action === "status") {
  const s = await status();
  console.log(!s ? "Native host executor: stopped" :
    `Native host executor: ${fresh(s) ? "healthy" : "stale or invalid"} (PID ${s.pid}, platform ${s.platform}, build ${s.buildId})`);
  if (s && !fresh(s)) process.exitCode = 1;
} else if (action === "stop") {
  const s = await status();
  if (!s) console.log("Native host executor: stopped");
  else {
    if (!fresh(s)) throw new Error("Refusing to stop a stale or invalid executor; inspect the queue");
    await controlStop();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await status()) await sleep(100);
    if (await status()) throw new Error("Executor did not stop; inspect the queue and process");
    console.log("Native host executor stopped");
  }
} else {
  if (!/^(1|true|yes|on)$/i.test(settings.MCP_HOST_EXECUTOR_ENABLED || "")) {
    throw new Error("Set MCP_HOST_EXECUTOR_ENABLED=true in .env first");
  }
  await mkdir(queue, { recursive: true, mode: 0o700 });
  const current = await status();
  if (current) {
    if (!fresh(current)) throw new Error("Executor status is stale or invalid; inspect the queue before starting");
    const build = process.env.MCP_BUILD_ID;
    if (build && current.buildId !== build) throw new Error("Executor build differs; stop it before starting the new build");
    console.log(`Native host executor already healthy (PID ${current.pid})`);
  } else {
    const log = openSync(path.join(queue, "agent-launch.log"), "a", 0o600);
    let child;
    try {
      child = spawn(process.execPath, [path.join(project, "scripts", "host-executor.mjs"), "--queue", queue], {
        cwd: project, detached: true, stdio: ["ignore", log, log],
        env: { ...process.env, MCP_HOST_EXECUTOR_BUILD_ID: process.env.MCP_BUILD_ID || "unknown" },
      });
    } finally { closeSync(log); }
    child.unref();
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const s = await status();
      if (s?.pid === child.pid && fresh(s)) {
        console.log(`Native host executor healthy (PID ${s.pid}, platform ${s.platform})`);
        process.exit(0);
      }
      if (child.exitCode !== null || child.signalCode !== null) break;
      await sleep(100);
    }
    throw new Error(`Executor failed to start; inspect ${path.join(queue, "agent-launch.log")}`);
  }
}
