import {randomUUID} from "node:crypto";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {expect,it,vi} from "vitest";
import {loadConfig} from "../src/config.js";
import {createServices} from "../src/mcp-server.js";
vi.mock("node:fs/promises",async(importOriginal)=>{
  const actual=await importOriginal<typeof import("node:fs/promises")>();return {...actual,readFile:vi.fn(actual.readFile)};
});
it("marks matching receipts inconclusive when originals change or a journal is pending, without replaying either",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mcp-report-race-"));
  const service=createServices(loadConfig({MCP_AUTH_TOKEN:"test",MCP_DEFAULT_CWD:root,MCP_CONTINUITY_STATE_DIR:path.join(root,"state")},root));
  const actual=await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  try{
    const task=await service.continuityService.create({cwd:root,requestId:randomUUID(),objective:"report race",checkpoint:{phase:"test",current:"inspect",completed:[],remaining:[],changedPaths:[],evidenceRefs:[],blockers:[]}});
    const prepared=(await service.executionRecorder.prepare({cwd:root,taskId:String(task.taskId),operationId:randomUUID(),toolKind:"run_script",semanticInput:{}})).record;
    const sessionId=randomUUID();await service.executionRecorder.markRunning(prepared,sessionId);
    const receipt=await service.executionRecorder.markTerminal(prepared.workspaceId,prepared.operationId,{sessionId,exitCode:0,signal:null,timedOut:false,totalOutputBytes:4});
    await service.continuityService.close();
    const directory=path.join(root,"state","workspaces",prepared.workspaceId),file=path.join(directory,"executions",`${prepared.operationId}.json`);
    const before=await readFile(file,"utf8");
    const {compareReceipts}=await import("../scripts/"+"usage-report-integrity.mjs");
    const entry={bootId:receipt.bootId,sessionId,correlation:{workspaceId:receipt.workspaceId,taskId:receipt.taskId,operationId:receipt.operationId},state:"lifecycle_matched",terminal:{exitCode:0,signal:null,timedOut:false,totalOutputBytes:4,spawnFailed:false}};
    expect((await compareReceipts([entry],path.join(root,"state")))[0].receipt).toBe("matched");
    let reads=0;
    vi.mocked(fs.readFile).mockImplementation((async(...args:any[])=>{
      const raw=await (actual.readFile as any)(...args);
      if(String(args[0])===file&&++reads===1)await writeFile(file,JSON.stringify({...receipt,errorCode:"changed"}));
      return raw;
    }) as typeof fs.readFile);
    expect((await compareReceipts([entry],path.join(root,"state")))[0].receipt).toBe("changed_during_observation");
    vi.mocked(fs.readFile).mockImplementation(actual.readFile);await writeFile(file,before);
    await mkdir(path.join(directory,"transactions"));const journal=path.join(directory,"transactions","pending.json");await writeFile(journal,"uncommitted sentinel");
    expect((await compareReceipts([entry],path.join(root,"state")))[0].receipt).toBe("pending_journal_inconclusive");
    expect(await readFile(journal,"utf8")).toBe("uncommitted sentinel");expect(await readFile(file,"utf8")).toBe(before);
  }finally{vi.mocked(fs.readFile).mockImplementation(actual.readFile);await service.processManager.shutdown();await service.continuityService.close();await rm(root,{recursive:true,force:true});}
});
