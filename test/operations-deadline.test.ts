import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";
import { observeWorkspace } from "../src/continuity/workspace-snapshot.js";

vi.mock("node:fs/promises",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("node:fs/promises")>();
  return {...actual,open:vi.fn(actual.open)};
});

it("validates read caps independently from wire wait and initial yield", () => {
  expect(loadConfig({MCP_AUTH_TOKEN:"test"}).processReadWaitMaxMs).toBe(60000);
  for (const n of [1000,300000]) expect(loadConfig({MCP_AUTH_TOKEN:"test",MCP_PROCESS_READ_WAIT_MAX_MS:String(n)}).processReadWaitMaxMs).toBe(n);
  for (const n of [0,999,300001,1.5]) expect(()=>loadConfig({MCP_AUTH_TOKEN:"test",MCP_PROCESS_READ_WAIT_MAX_MS:String(n)})).toThrow("MCP_PROCESS_READ_WAIT_MAX_MS");
});

it("bounds terminal persistence response waits without cancelling or duplicating the terminal write", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"mcp-response-deadline-"));
  const config=loadConfig({MCP_AUTH_TOKEN:"test",MCP_DEFAULT_CWD:root,MCP_CONTINUITY_STATE_DIR:path.join(root,"state"),MCP_PROCESS_READ_WAIT_MAX_MS:"1000"},root);
  config.host="127.0.0.1";config.port=0;
  const services=createServices(config),server=await startHttpServer(config,services);
  const endpoint=`http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`;
  const call=async(name:string,args:Record<string,unknown>,signal?:AbortSignal)=>{
    const response=await fetch(endpoint,{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}}),signal});
    const body=await response.json();expect(body.result.isError).not.toBe(true);return body.result.structuredContent;
  };
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const original=services.executionRecorder.markTerminal.bind(services.executionRecorder);
  const terminal=vi.spyOn(services.executionRecorder,"markTerminal").mockImplementation(async(...args)=>{await gate;return original(...args);});
  try {
    const task=await services.continuityService.create({cwd:root,requestId:randomUUID(),objective:"deadline",checkpoint:{phase:"test",current:"inspect",completed:[],remaining:[],changedPaths:[],evidenceRefs:[],blockers:[]}});
    const operationId=randomUUID();
    const started=await call("run_script",{runtime:"node",script:"setTimeout(()=>console.log('done'),100)",taskId:task.taskId,operationId,yieldTimeMs:0});
    await services.processManager.waitForExit(started.sessionId,2000);
    const abort=new AbortController();
    const cancelled=call("read_process",{sessionId:started.sessionId,waitMs:0},abort.signal);
    setTimeout(()=>abort.abort(),30);
    await expect(cancelled).rejects.toThrow();
    const begin=performance.now();
    const pending=await call("read_process",{sessionId:started.sessionId,waitMs:0,drainOnly:true});
    expect(performance.now()-begin).toBeLessThan(5500);
    expect(pending).toMatchObject({completed:true,persistenceVerification:"pending",effectiveWaitMs:0,responseBudgetMs:5000,responseDeadlineExceeded:true,nextCall:{tool:"read_process"}});
    expect(pending.persistenceState).not.toBe("degraded");
    expect(pending.persistenceState).not.toBe("unknown");
    release();
    const verified=await call("read_process",{sessionId:started.sessionId,afterSeq:pending.nextSeq,waitMs:0});
    expect(verified).toMatchObject({completed:true,persistenceVerification:"verified",executionState:"exited",persistenceState:"ok"});
    expect(verified).not.toHaveProperty("nextCall");
    expect(terminal).toHaveBeenCalledTimes(1);
    const receipt=await services.executionRecorder.store.readExecution(started.workspaceId ?? (await services.continuityService.workspaceIdentity.resolve(root)).workspaceId,operationId);
    expect(receipt).toMatchObject({state:"exited",persistenceState:"ok"});
    // Hold the actual storage queue in receipt durability sync, rather than
    // replacing the handler with an already-timed-out stub.
    const actualFs=await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let unlock!:()=>void,entered!:()=>void;
    const lockGate=new Promise<void>(resolve=>{unlock=resolve;}),lockReady=new Promise<void>(resolve=>{entered=resolve;});
    let held=false;
    // Force a fresh on-disk durability check; warm receipts use prior proof.
    await services.executionRecorder.store.invalidateWorkspace(receipt!.workspaceId);
    vi.mocked(fs.open).mockImplementation(async(file,flags,mode)=>{
      const handle=await actualFs.open(file,flags,mode);
      if(!held&&String(file).endsWith(`${operationId}.json`)&&flags==="r+"){
        held=true;const sync=handle.sync.bind(handle);handle.sync=async()=>{entered();await lockGate;return sync();};
      }
      return handle;
    });
    const blockedRead=services.executionRecorder.store.readExecution(receipt!.workspaceId,operationId);
    try{
      await lockReady;
      const queued=await call("read_process",{sessionId:started.sessionId,waitMs:0});
      expect(queued).toMatchObject({persistenceVerification:"pending",responseDeadlineExceeded:true});
      expect(queued.persistenceState).not.toBe("degraded");
    }finally{unlock();await blockedRead;vi.mocked(fs.open).mockImplementation(actualFs.open);}
    expect((await call("read_process",{sessionId:started.sessionId,waitMs:0})).persistenceVerification).toBe("verified");
    expect(terminal).toHaveBeenCalledTimes(1);
    const live=await call("run_script",{runtime:"node",script:"setTimeout(()=>{},10000)",taskId:task.taskId,operationId:randomUUID(),yieldTimeMs:0});
    const capStart=performance.now();
    const capped=await call("read_process",{sessionId:live.sessionId,waitMode:"terminal",waitMs:300000});
    expect(performance.now()-capStart).toBeLessThan(2000);
    expect(capped).toMatchObject({running:true,requestedWaitMs:300000,effectiveWaitMs:1000,responseBudgetMs:6000,persistenceVerification:"not_required"});
    const controller=new AbortController();
    const remove=vi.spyOn(controller.signal,"removeEventListener");
    const read=services.processManager.read(live.sessionId,{waitMode:"terminal",waitMs:300000,signal:controller.signal});
    controller.abort();await expect(read).rejects.toThrow();
    expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));
    expect((await services.processManager.read(live.sessionId)).running).toBe(true);
  } finally {release();vi.restoreAllMocks();await server.close();await rm(root,{recursive:true,force:true});}
},20000);

it.skipIf(process.platform==="win32")("kills and reaps a slow Git child within the two-second observation budget",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mcp-git-deadline-"));
  const bin=path.join(root,"bin"),pidFile=path.join(root,"pid");await mkdir(bin);
  await writeFile(path.join(bin,"git"),`#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(pidFile)},String(process.pid)+'\\n');setInterval(()=>{},1000);\n`,{mode:0o755});
  vi.stubEnv("PATH",`${bin}${path.delimiter}${process.env.PATH}`);
  try {
    const start=performance.now();
    const result=await observeWorkspace({workspaceId:"a".repeat(32),executionRoot:root,gitRoot:root,gitCommonDir:path.join(root,".git"),worktreeIdentity:root,repository:true},{maxFiles:200,maxBytes:16777216,maxDurationMs:2000});
    expect(performance.now()-start).toBeLessThan(2500);
    expect(result.completeness).toBe("partial");expect(result.reasons).toContain("time_budget_exceeded");
    const pids=(await readFile(pidFile,"utf8")).trim().split("\n").map(Number);
    expect(pids).toHaveLength(3);
    for(const pid of pids) expect(()=>process.kill(pid,0)).toThrow();
  } finally {vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});
