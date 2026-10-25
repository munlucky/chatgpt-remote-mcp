import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

import { loadConfig } from "../src/config.js";
import { startHttpServer, type RunningHttpServer } from "../src/http-server.js";
import { createServices, type McpServices } from "../src/mcp-server.js";
import { OperatorApprovalStore } from "../src/operator-approval-store.js";
import type { ApprovalInput } from "../src/operator-approval.js";
import { createBearerAuth } from "../src/auth.js";
import { RemoteDevOAuthProvider } from "../src/oauth.js";
import { requestPrincipal } from "../src/request-principal.js";

const key = "test-operator-key-independent-123456789";
const principal = `bearer:${createHash("sha256").update("test-bearer").digest("hex")}`;

// A deliberately small CLI double. These tests never touch the installed Kernel.
const fakeKernel = `import fs from 'node:fs';
import path from 'node:path';
const home=process.env.MOON_RELAY_KERNEL_HOME;
const command=process.argv[3];
const scenarioFile=path.join(home,'scenario.json');
const scenario=fs.existsSync(scenarioFile)?JSON.parse(fs.readFileSync(scenarioFile,'utf8')):{};
fs.appendFileSync(path.join(home,'calls.jsonl'),JSON.stringify({command,cwd:process.cwd(),keyPresent:Boolean(process.env.MCP_OPERATOR_APPROVAL_KEY),args:process.argv.slice(4)})+'\\n');
if(command==='status'){
 const adopted=fs.existsSync(path.join(home,'adopted'));
 const root=process.cwd().replaceAll('\\\\','/').replace(/\\/+$/,'');
 const wrongPath=scenario.expectedCwd && process.cwd()!==scenario.expectedCwd;
 console.log(JSON.stringify({status:wrongPath?'bootstrap_required':adopted?'ready':'repair_required',projectId:wrongPath?'canonical-path-project':adopted?'legacy-project':(scenario.changed?'changed-project':'source-project'),resolvedProjectId:'source-project',canonicalRoot:process.platform==='win32'?root.toLowerCase():root,runtimeHome:home,legacyCandidates:[{projectId:'legacy-project',hasData:true,hasPersistedIdentity:false,sameRootEvidence:true}]}));
}else if(command==='approve'){
 fs.writeFileSync(path.join(home,'approved'), 'yes'); console.log('{}');
}else if(command==='repair'){
 if(scenario.fail){process.exitCode=1;}else{fs.writeFileSync(path.join(home,'adopted'),'yes');console.log(JSON.stringify({status:'ready',mutation:'identity-adopted-without-data-rewrite',receipt:{receiptId:'test-receipt'}}));}
}else{process.exitCode=2;}
`;

describe("operator approval bridge", () => {
  let root: string;
  let kernelHome: string;
  let services: McpServices;
  let running: RunningHttpServer | undefined;
  let input: ApprovalInput;
  let endpoint: string;
  let aliasRoot: string;
  let continuityRoot: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "operator-approval-"));
    aliasRoot = path.join(root, "kernel-view");
    continuityRoot = path.join(root, "continuity-view");
    await mkdir(aliasRoot);
    await mkdir(continuityRoot);
    kernelHome = path.join(root, "kernel");
    const payload = path.join(kernelHome, ".moon-relay/kernel-payload");
    await mkdir(path.join(payload, "bin"), { recursive: true });
    await mkdir(path.join(payload, "scripts/application/kernel-cli"), { recursive: true });
    await mkdir(path.join(payload, "scripts/kernel"), { recursive: true });
    await writeFile(path.join(payload, "bin/moon-relay-kernel.mjs"), fakeKernel);
    await writeFile(path.join(payload, "scripts/application/kernel-cli/main.js"), "// fixture\n");
    await writeFile(path.join(payload, "scripts/kernel/project-identity-preflight.js"), "// fixture\n");
    const config = loadConfig({ MCP_AUTH_TOKEN: "test-bearer", MCP_HOST: "127.0.0.1", MCP_PUBLIC_URL: "http://127.0.0.1",
      MCP_OPERATOR_APPROVAL_ENABLED: "true", MCP_OPERATOR_APPROVAL_KEY: key, MOON_RELAY_KERNEL_HOME: kernelHome,
      MCP_CONTINUITY_STATE_DIR: path.join(root, "state"), MCP_DEFAULT_CWD: root,
      MCP_WORKSPACE_ALIASES: `${aliasRoot}=${continuityRoot}` }, root);
    config.port = 0;
    services = createServices(config);
    running = await startHttpServer(config, services);
    endpoint = `http://127.0.0.1:${(running.httpServer.address() as AddressInfo).port}`;
    const task = await services.continuityService.create({ cwd: root, requestId: randomUUID(), objective: "test identity adoption",
      checkpoint: { phase: "approval", current: "Waiting for operator", completed: [], remaining: ["identity"], blockers: [], changedPaths: [], evidenceRefs: [] } });
    input = { taskId: String(task.taskId), requestId: randomUUID(), cwd: root, operation: "kernel_identity_adopt",
      sourceProjectId: "source-project", legacyProjectId: "legacy-project", reason: "Windows legacy identity adoption <script>alert(1)</script>" };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await running?.close();
    running = undefined;
    const resolved = path.resolve(root);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unexpected cleanup path");
    await rm(resolved, { recursive: true, force: true });
  });

  async function rpc(name: string, args: Record<string, unknown>, bearer = "test-bearer") {
    const response = await fetch(`${endpoint}/mcp`, { method: "POST", headers: {
      authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream",
    }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
    const payload = await response.json() as { result: { isError?: boolean; structuredContent: Record<string, unknown> } };
    return payload.result;
  }

  async function request() {
    const result = await rpc("request_operator_approval", { ...input });
    expect(result.isError).not.toBe(true);
    return result.structuredContent;
  }

  async function form(view: Record<string, unknown>) {
    const url = new URL(String(view.approvalUrl));
    const response = await fetch(`${endpoint}${url.pathname}${url.search}`);
    const html = await response.text();
    return { url, html, cookie: response.headers.get("set-cookie")!.split(";")[0]!,
      csrf: html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1] ?? "" };
  }

  async function decide(view: Record<string, unknown>, decision = "approve") {
    const f = await form(view);
    return fetch(`${endpoint}${f.url.pathname}`, { method: "POST", headers: {
      origin: "http://127.0.0.1", cookie: f.cookie, "content-type": "application/x-www-form-urlencoded",
    }, body: new URLSearchParams({ token: f.url.searchParams.get("token")!, csrf: f.csrf, key, decision }) });
  }

  async function settled(id: string) {
    await vi.waitFor(async () => {
      expect(["succeeded", "unknown"]).toContain((await services.operatorApprovalService.get(id, principal)).status);
    }, { timeout: 7000, interval: 30 });
    return services.operatorApprovalService.get(id, principal);
  }

  async function useAliasTask() {
    const task = await services.continuityService.create({ cwd: continuityRoot, requestId: randomUUID(),
      objective: "Adopt identity through a separate Kernel path",
      checkpoint: { phase: "approval", current: "Waiting", completed: [], remaining: ["identity"], blockers: [], changedPaths: [], evidenceRefs: [] } });
    input = { ...input, taskId: String(task.taskId), cwd: path.relative(root, aliasRoot) };
    return services.continuityService.workspaceIdentity.resolve(continuityRoot);
  }

  it("keeps the requested Kernel path through consent and execution while binding the canonical continuity workspace", async () => {
    const workspace = await useAliasTask();
    const kernelCwd = await realpath(aliasRoot);
    await writeFile(path.join(kernelHome, "scenario.json"), JSON.stringify({ expectedCwd: kernelCwd }));
    const view = await request();
    expect(view.cwd).toBe(kernelCwd);
    const record = await services.operatorApprovalService.store.read(records => records.find(r => r.id === view.approvalRequestId)!);
    expect(record).toMatchObject({ cwd: kernelCwd, workspaceId: workspace.workspaceId });
    expect((await form(view)).html).toContain(kernelCwd);
    // The same files may have a different Kernel identity at the continuity path.
    const canonical = await rpc("request_operator_approval", { ...input, requestId: randomUUID(), cwd: continuityRoot });
    expect(canonical.structuredContent.code).toBe("approval_identity_mismatch");
    expect((await decide(view)).status).toBe(200);
    const operationId = randomUUID();
    await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId });
    expect(await settled(String(view.approvalRequestId))).toMatchObject({ status: "succeeded" });
    const calls = (await readFile(path.join(kernelHome, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.command !== "status").map(call => call.cwd)).toEqual([kernelCwd, kernelCwd]);
    expect(calls.filter(call => call.cwd === kernelCwd && call.command === "status")).toHaveLength(3);
    expect((await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId })).isError).not.toBe(true);
  });

  it("does not accept another workspace's task when retaining the original Kernel cwd", async () => {
    const result = await rpc("request_operator_approval", { ...input, cwd: aliasRoot });
    expect(result.structuredContent.code).toBe("approval_task_mismatch");
    await expect(readFile(path.join(kernelHome, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks unresolved identity execution across different Kernel paths in the same continuity workspace", async () => {
    await useAliasTask();
    const first = await request();
    const second = (await rpc("request_operator_approval", { ...input, requestId: randomUUID(), cwd: continuityRoot })).structuredContent;
    expect(second.cwd).not.toBe(first.cwd);
    expect((await decide(first)).status).toBe(200);
    expect((await decide(second)).status).toBe(200);
    await writeFile(path.join(kernelHome, "scenario.json"), JSON.stringify({ fail: true }));
    await rpc("execute_approved_operation", { approvalRequestId: first.approvalRequestId, operationId: randomUUID() });
    expect(await settled(String(first.approvalRequestId))).toMatchObject({ status: "unknown" });
    const blocked = await rpc("execute_approved_operation", { approvalRequestId: second.approvalRequestId, operationId: randomUUID() });
    expect(blocked.structuredContent.code).toBe("approval_unresolved_execution");
    const calls = await readFile(path.join(kernelHome, "calls.jsonl"), "utf8");
    expect(calls.match(/"command":"approve"/g)).toHaveLength(1);
  });

  it("binds human consent to a fixed operation, executes once, and verifies the resulting identity", async () => {
    const view = await request();
    const id = String(view.approvalRequestId);
    expect(view.status).toBe("pending");
    expect((await rpc("execute_approved_operation", { approvalRequestId: id, operationId: randomUUID() })).structuredContent.code).toBe("approval_required");
    const f = await form(view);
    expect(f.html).toContain("&lt;script&gt;");
    expect(f.html).not.toContain("<script>alert");
    expect(f.html).not.toContain(key);
    expect((await decide(view)).status).toBe(200);
    const approved = (await rpc("get_operator_approval", { approvalRequestId: id })).structuredContent;
    expect(approved).toMatchObject({ status: "approved", decidedBy: "operator-key-holder" });
    expect(approved.approvalRef).toMatch(/^moonremote:approval:/);
    const operationId = randomUUID();
    const [first, duplicate] = await Promise.all([rpc("execute_approved_operation", { approvalRequestId: id, operationId }), rpc("execute_approved_operation", { approvalRequestId: id, operationId })]);
    expect(first.isError).not.toBe(true);
    expect(duplicate.isError).not.toBe(true);
    const finished = await settled(id);
    expect(finished, JSON.stringify(await services.processManager.read(String(finished.sessionId)))).toMatchObject({ status: "succeeded", result: { projectId: "legacy-project", receiptId: "test-receipt" } });
    expect((await rpc("execute_approved_operation", { approvalRequestId: id, operationId: randomUUID() })).structuredContent.code).toBe("approval_already_consumed");
    const calls = (await readFile(path.join(kernelHome, "calls.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(calls.filter(call => call.command === "approve")).toHaveLength(1);
    expect(calls.filter(call => call.command === "repair")).toHaveLength(1);
    expect(calls.every(call => !call.keyPresent)).toBe(true);
  });

  it("enforces transport ownership, exact-request idempotency, and target binding", async () => {
    const view = await request();
    expect((await request()).approvalRequestId).toBe(view.approvalRequestId);
    expect((await rpc("request_operator_approval", { ...input, reason: "different" })).structuredContent.code).toBe("idempotency_conflict");
    await expect(services.operatorApprovalService.get(String(view.approvalRequestId), "other-grant")).rejects.toMatchObject({ code: "approval_not_found" });
    await expect(services.operatorApprovalService.get(String(view.approvalRequestId))).rejects.toMatchObject({ code: "approval_auth_required" });
    expect((await rpc("request_operator_approval", { ...input, requestId: randomUUID(), sourceProjectId: "wrong" })).structuredContent.code).toBe("approval_identity_mismatch");
  });

  it("keeps OAuth approval ownership through token refresh and separates another grant", async () => {
    const config = loadConfig({ MCP_OAUTH_ENABLED: "true", MCP_OAUTH_APPROVAL_KEY: "connection-login",
      MCP_PUBLIC_URL: "http://127.0.0.1", MCP_OAUTH_STATE_FILE: path.join(root, "oauth.json") }, root);
    const provider = new RemoteDevOAuthProvider(config);
    const client = await provider.clientsStore.registerClient({ redirect_uris: ["http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    const tokens = await provider.clientsStore.issueTokenPair(client.client_id, ["mcp:tools"], config.oauthResourceUrl!);
    const authenticate = async (token: string) => {
      let identity: string | undefined;
      await createBearerAuth(config, provider)({ header: () => `Bearer ${token}` } as unknown as Request,
        {} as Response, () => { identity = requestPrincipal.getStore(); });
      expect(identity).toMatch(/^oauth:/);
      return identity!;
    };
    const original = await authenticate(tokens.access_token);
    const view = await services.operatorApprovalService.request(input, original);
    const refreshed = await provider.clientsStore.rotateRefreshToken(tokens.refresh_token!, client.client_id, config.oauthResourceUrl!, undefined);
    if (refreshed.status !== "ok") throw new Error("refresh failed");
    const sameGrant = await authenticate(refreshed.tokens.access_token);
    expect(sameGrant).toBe(original);
    expect((await services.operatorApprovalService.get(String(view.approvalRequestId), sameGrant)).status).toBe("pending");
    const another = await provider.clientsStore.issueTokenPair(client.client_id, ["mcp:tools"], config.oauthResourceUrl!);
    await expect(services.operatorApprovalService.get(String(view.approvalRequestId), await authenticate(another.access_token))).rejects.toMatchObject({ code: "approval_not_found" });
  });

  it("rejects cross-origin, missing-CSRF, and incorrect-key decisions and rate limits failed authentication", async () => {
    const view = await request();
    const f = await form(view);
    for (const origin of ["https://attacker.example", ""]) {
      const response = await fetch(`${endpoint}${f.url.pathname}`, { method: "POST", headers: { origin }, body: "" });
      expect(response.status).toBe(403);
    }
    for (let i = 0; i < 6; i++) {
      const response = await fetch(`${endpoint}${f.url.pathname}`, { method: "POST", headers: {
        origin: "http://127.0.0.1", "content-type": "application/x-www-form-urlencoded",
      }, body: new URLSearchParams({ token: f.url.searchParams.get("token")!, csrf: f.csrf, key: "wrong", decision: "approve" }) });
      expect(response.status).toBe(i < 5 ? 403 : 429);
    }
    expect((await services.operatorApprovalService.get(String(view.approvalRequestId), principal)).status).toBe("pending");
  });

  it("does not execute denied or expired approvals", async () => {
    const view = await request();
    expect((await decide(view, "deny")).status).toBe(200);
    expect((await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId: randomUUID() })).structuredContent.code).toBe("approval_required");
    const second = await rpc("request_operator_approval", { ...input, requestId: randomUUID() });
    const id = String(second.structuredContent.approvalRequestId);
    await services.operatorApprovalService.store.mutate(records => { records.find(r => r.id === id)!.expiresAt = new Date(Date.now() - 1).toISOString(); });
    expect((await services.operatorApprovalService.get(id, principal)).status).toBe("expired");
    const f = await form(second.structuredContent);
    expect(f.html).not.toContain('name="key"');
    expect((await rpc("execute_approved_operation", { approvalRequestId: id, operationId: randomUUID() })).structuredContent.code).toBe("approval_required");
  });

  it("expires a previously approved request and rejects closed task bindings", async () => {
    const view = await request();
    await decide(view);
    const id = String(view.approvalRequestId);
    await services.operatorApprovalService.store.mutate(records => { records.find(r => r.id === id)!.expiresAt = new Date(Date.now() - 1).toISOString(); });
    expect((await rpc("execute_approved_operation", { approvalRequestId: id, operationId: randomUUID() })).structuredContent.code).toBe("approval_required");
    const other = (await rpc("request_operator_approval", { ...input, requestId: randomUUID() })).structuredContent;
    await decide(other);
    await services.continuityService.complete({ taskId: input.taskId, requestId: randomUUID(), expectedRevision: 1, outcome: "abandoned", summary: "closed before execution", evidenceRefs: [] });
    expect((await rpc("execute_approved_operation", { approvalRequestId: other.approvalRequestId, operationId: randomUUID() })).structuredContent.code).toBe("approval_task_mismatch");
  });

  it("rejects altered view tokens and changed Kernel installation files", async () => {
    const view = await request();
    const url = new URL(String(view.approvalUrl));
    expect((await fetch(`${endpoint}${url.pathname}?token=forged`)).status).toBe(404);
    await decide(view);
    await writeFile(path.join(kernelHome, ".moon-relay/kernel-payload/scripts/kernel/project-identity-preflight.js"), "// changed after consent\n");
    await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId: randomUUID() });
    expect(await settled(String(view.approvalRequestId))).toMatchObject({ status: "unknown", result: { stage: "preflight" } });
    expect(await readFile(path.join(kernelHome, "calls.jsonl"), "utf8")).not.toContain('"command":"approve"');
  });

  it("publishes the three optional tools and keeps credentials out of inherited process environments", async () => {
    const response = await fetch(`${endpoint}/mcp`, { method: "POST", headers: { authorization: "Bearer test-bearer",
      accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
    const catalog = (await response.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(catalog).toHaveLength(28);
    expect(catalog.map(t => t.name)).toEqual(expect.arrayContaining(["request_operator_approval", "get_operator_approval", "execute_approved_operation"]));
    vi.stubEnv("MCP_OPERATOR_APPROVAL_KEY", "should-not-reach-child");
    try {
      const id = services.processManager.start({ executable: process.execPath,
        args: ["-e", "console.log(Boolean(process.env.MCP_OPERATOR_APPROVAL_KEY))"],
        env: { MCP_OPERATOR_APPROVAL_KEY: "also-removed" }, commandForDisplay: "credential exclusion test", cwd: root });
      await services.processManager.waitForExit(id, 3000);
      expect((await services.processManager.read(id)).stdout.trim()).toBe("false");
    } finally { vi.unstubAllEnvs(); }
  });

  it("fails closed on identity drift and does not issue the Kernel approval", async () => {
    const view = await request();
    await decide(view);
    await writeFile(path.join(kernelHome, "scenario.json"), JSON.stringify({ changed: true }));
    await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId: randomUUID() });
    expect(await settled(String(view.approvalRequestId))).toMatchObject({ status: "unknown", result: { stage: "preflight" } });
    expect(await readFile(path.join(kernelHome, "calls.jsonl"), "utf8")).not.toContain('"command":"approve"');
  });

  it("keeps failed repair unknown, blocks completion, and never repeats an uncertain execution", async () => {
    const view = await request();
    await decide(view);
    await writeFile(path.join(kernelHome, "scenario.json"), JSON.stringify({ fail: true }));
    const operationId = randomUUID();
    await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId });
    expect(await settled(String(view.approvalRequestId))).toMatchObject({ status: "unknown", result: { stage: "repair" } });
    expect((await services.continuityService.context({ taskId: input.taskId, format: "summary" })).operatorApprovals).toEqual([
      expect.objectContaining({ approvalRequestId: view.approvalRequestId, status: "unknown" }),
    ]);
    await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId });
    const calls = await readFile(path.join(kernelHome, "calls.jsonl"), "utf8");
    expect(calls.match(/"command":"repair"/g)).toHaveLength(1);
    await expect(services.continuityService.complete({ taskId: input.taskId, requestId: randomUUID(), expectedRevision: 1,
      outcome: "abandoned", summary: "test", evidenceRefs: [] })).rejects.toMatchObject({ code: "unresolved_execution" });
  });

  it("recovers interrupted executions as unknown and rejects signed-ledger tampering", async () => {
    const view = await request();
    const directory = services.operatorApprovalService.store.directory;
    await services.operatorApprovalService.store.mutate(records => {
      const record = records.find(r => r.id === view.approvalRequestId)!;
      record.status = "executing"; record.operationId = randomUUID();
    });
    await running!.close(); running = undefined;
    const recovered = new OperatorApprovalStore(directory, key);
    await recovered.initialize();
    expect(await recovered.read(records => records[0]!.status)).toBe("unknown");
    await recovered.close();
    const ledger = path.join(directory, "ledger.json");
    const envelope = JSON.parse(await readFile(ledger, "utf8"));
    envelope.payload.records[0].status = "approved";
    await writeFile(ledger, JSON.stringify(envelope));
    await expect(new OperatorApprovalStore(directory, key).initialize()).rejects.toThrow("signature");
  });

  it("refuses a second ledger writer without affecting the active service", async () => {
    await request();
    await expect(new OperatorApprovalStore(services.operatorApprovalService.store.directory, key).initialize()).rejects.toThrow("writer");
    expect((await request()).status).toBe("pending");
  });

  it("does not spawn when durable approval consumption fails", async () => {
    const view = await request();
    await decide(view);
    const ledger = path.join(services.operatorApprovalService.store.directory, "ledger.json");
    await unlink(ledger);
    await mkdir(ledger); // Makes the atomic rename fail on both Windows and Linux.
    const execution = await rpc("execute_approved_operation", { approvalRequestId: view.approvalRequestId, operationId: randomUUID() });
    expect(execution.isError).toBe(true);
    expect(execution.structuredContent.code).toBe("persistence_unavailable");
    expect(services.processManager.list()).toHaveLength(0);
    expect(await readFile(path.join(kernelHome, "calls.jsonl"), "utf8")).not.toContain('"command":"approve"');
  });
});

describe("operator approval configuration", () => {
  const base = { MCP_AUTH_TOKEN: "bearer", MCP_PUBLIC_URL: "https://mcp.example.com", MCP_OPERATOR_APPROVAL_ENABLED: "true", MCP_OPERATOR_APPROVAL_KEY: key };
  it("requires independent operator credentials and bounded TTL", () => {
    expect(() => loadConfig({ ...base, MCP_OPERATOR_APPROVAL_KEY: "short" })).toThrow("32 to 512");
    expect(() => loadConfig({ ...base, MCP_AUTH_TOKEN: key })).toThrow("independent");
    expect(() => loadConfig({ ...base, MCP_PROBE_SECRET: key })).toThrow("independent");
    expect(() => loadConfig({ ...base, MCP_OPERATOR_APPROVAL_TTL_SECONDS: "3601" })).toThrow("60 and 3600");
    expect(() => loadConfig({ ...base, MCP_PUBLIC_URL: "http://mcp.example.com" })).toThrow("HTTPS");
    expect(() => loadConfig({ ...base, MCP_PUBLIC_URL: "https://mcp.example.com/prefix" })).toThrow("origin root");
    expect(() => loadConfig({ ...base, MCP_AUTH_TOKEN: "", MCP_ALLOW_NO_AUTH: "true" })).toThrow("built-in");
    expect(loadConfig({ MCP_AUTH_TOKEN: "bearer" }).operatorApprovalEnabled).toBe(false);
  });
});
