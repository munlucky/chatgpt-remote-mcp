import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import {requestMetrics,type RequestMetrics} from "../src/telemetry.js";

it("keeps the same operation ID independent across workspace mutations and full integrity boundaries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-owner-boundary-"));
  const service = createServices(loadConfig({ MCP_AUTH_TOKEN:"test", MCP_DEFAULT_CWD:root, MCP_CONTINUITY_STATE_DIR:path.join(root,"state") }, root));
  const operationId = randomUUID();
  try {
    const records = [];
    for (const name of ["a", "b"]) {
      const cwd = path.join(root,name); await mkdir(cwd);
      const task = await service.continuityService.create({cwd, requestId:randomUUID(), objective:name,
        checkpoint:{phase:"test", current:"inspect", completed:[], remaining:[], changedPaths:[], evidenceRefs:[], blockers:[]}});
      const input = {cwd, taskId:String(task.taskId), operationId, toolKind:"run_script" as const, semanticInput:{name}};
      const prepared = await service.executionRecorder.prepare(input);
      expect(prepared.shouldSpawn).toBe(true);
      expect((await service.executionRecorder.prepare(input)).shouldSpawn).toBe(false);
      records.push(prepared.record);
    }
    const [a,b] = records;
    await service.executionRecorder.markRunning(a!, "session-a");
    await service.executionRecorder.markSpawnFailed(b!);
    const store = service.continuityService.store;
    expect(await store.readExecution(a!.workspaceId,operationId)).toMatchObject({state:"running",sessionId:"session-a",taskId:a!.taskId});
    expect(await store.readExecution(b!.workspaceId,operationId)).toMatchObject({state:"spawn_failed",sessionId:null,taskId:b!.taskId});
    await service.executionRecorder.markTerminal(a!.workspaceId,operationId,{sessionId:"session-a",exitCode:0,signal:null,timedOut:false,totalOutputBytes:7});
    await service.executionRecorder.markPersistenceDegraded(a!.workspaceId,operationId);
    await store.invalidateWorkspace(a!.workspaceId);
    expect(await store.readExecution(a!.workspaceId,operationId)).toMatchObject({state:"exited",persistenceState:"degraded",outputBytes:7});
    const metrics:RequestMetrics={setupMs:null,toolMs:null,toolError:null};
    expect(await requestMetrics.run(metrics,()=>store.readExecution(b!.workspaceId,operationId))).toMatchObject({state:"spawn_failed",persistenceState:"ok"});
    expect(metrics.continuity?.indexRebuilds??0).toBe(0);
    await store.integrityScan();
    const file = path.join(root,"state","workspaces",a!.workspaceId,"executions",`${operationId}.json`);
    const valid = await readFile(file,"utf8");
    await writeFile(file,JSON.stringify({...JSON.parse(valid),taskId:b!.taskId}));
    await expect(store.readExecution(a!.workspaceId,operationId)).rejects.toMatchObject({code:"state_corrupt"});
    await expect(store.integrityScan(a!.workspaceId)).rejects.toMatchObject({code:"state_corrupt"});
    await expect(store.integrityScan(b!.workspaceId)).resolves.toBeUndefined();
    await store.close();
    await expect(store.initialize()).rejects.toMatchObject({code:"state_corrupt"});
    expect(await readFile(file,"utf8")).toContain(b!.taskId);
  } finally {await service.processManager.shutdown();await service.continuityService.close();await rm(root,{recursive:true,force:true});}
});

it("rebuilds from originals, pages unsettled receipts, and checks evidence outside recent N", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcp-index-boundary-"));
  const service = createServices(loadConfig({MCP_AUTH_TOKEN:"test",MCP_DEFAULT_CWD:root,MCP_CONTINUITY_STATE_DIR:path.join(root,"state")},root));
  const store = service.continuityService.store;
  try {
    const task = await service.continuityService.create({cwd:root,requestId:randomUUID(),objective:"bounded query",checkpoint:{phase:"test",current:"inspect",completed:[],remaining:[],changedPaths:[],evidenceRefs:[],blockers:[]}});
    const prepared = (await service.executionRecorder.prepare({cwd:root,taskId:String(task.taskId),operationId:randomUUID(),toolKind:"run_script",semanticInput:{}})).record;
    const directory = path.join(root,"state","workspaces",prepared.workspaceId);
    await store.close();
    const state = JSON.parse(await readFile(path.join(directory,"state.json"),"utf8"));
    const otherTask = randomUUID();
    state.tasks[otherTask] = {...structuredClone(state.tasks[prepared.taskId]),taskId:otherTask,status:"completed",completedAt:new Date().toISOString()};
    const evidenceId = randomUUID();
    state.tasks[prepared.taskId].checkpoint.evidenceRefs = [{kind:"receipt",operationId:evidenceId}];
    await writeFile(path.join(directory,"state.json"),JSON.stringify(state));
    const unrelatedId = randomUUID();
    for (let i=0;i<40;i++) {
      const operationId = i===0?evidenceId:i===39?unrelatedId:randomUUID();
      const record = {...prepared,operationId,taskId:i===39?otherTask:prepared.taskId,state:i<16?"spawn_failed":"unknown",preparedAt:new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(),endedAt:new Date().toISOString()};
      await writeFile(path.join(directory,"executions",`${operationId}.json`),JSON.stringify(record));
    }
    await store.initialize();
    const result = await service.continuityService.context({taskId:prepared.taskId,format:"summary",recentExecutionLimit:1});
    expect(result.evidence).toBe("present");
    expect((result.executions as any).recent).toHaveLength(1);
    const ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await store.executionContext(prepared.workspaceId,prepared.taskId,1,cursor,10);
      expect(page.unsettledTotal).toBe(24); // 23 explicit unknown plus previous-boot prepared
      ids.push(...page.unsettled.map(record=>record.operationId));cursor=page.nextCursor??undefined;
    } while(cursor);
    expect(new Set(ids).size).toBe(24);
    await expect(store.executionContext(prepared.workspaceId,prepared.taskId,1,`${otherTask}:${ids[0]}`)).rejects.toThrow();
    const unrelated = path.join(directory,"executions",`${unrelatedId}.json`);
    const original = await readFile(unrelated,"utf8");
    await writeFile(unrelated,"{broken");
    await expect(store.readExecution(prepared.workspaceId,evidenceId)).resolves.toMatchObject({operationId:evidenceId});
    await expect(store.integrityScan(prepared.workspaceId)).rejects.toThrow();
    // A failed scan cannot leave a previously accepted index available.
    await expect(store.readExecution(prepared.workspaceId,evidenceId)).rejects.toThrow();
    await writeFile(unrelated,original);
    await expect(store.readExecution(prepared.workspaceId,evidenceId)).resolves.toBeDefined();
    await store.invalidateWorkspace(prepared.workspaceId);
    await expect(store.readExecution(prepared.workspaceId,evidenceId)).resolves.toBeDefined();
    expect((await readdir(directory)).some(name=>/index|generation/.test(name))).toBe(false);
    await writeFile(unrelated,"{broken");await store.close();
    await expect(store.initialize()).rejects.toThrow();
  } finally {await service.processManager.shutdown();await store.close();await rm(root,{recursive:true,force:true});}
});
