import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/mcp-server.js";
import { startHttpServer } from "../src/http-server.js";

it("follows nextCall verbatim through UTF-8 drains, restores terminal policy, and recovers only validated expired receipts",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"mcp-continuation-"));
  const config=loadConfig({MCP_AUTH_TOKEN:"test",MCP_DEFAULT_CWD:root,MCP_PROCESS_RETENTION_MS:"1000",MCP_CONTINUITY_STATE_DIR:path.join(root,"state")},root);
  config.host="127.0.0.1";config.port=0;
  const services=createServices(config),server=await startHttpServer(config,services);
  const call=async(name:string,args:Record<string,unknown>)=>{
    const response=await fetch(`http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}/mcp`,{method:"POST",headers:{authorization:"Bearer test","content-type":"application/json",accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name,arguments:args}})});
    return (await response.json()).result;
  };
  try {
    const task=await services.continuityService.create({cwd:root,requestId:randomUUID(),objective:"continuation",checkpoint:{phase:"test",current:"inspect",completed:[],remaining:[],changedPaths:[],evidenceRefs:[],blockers:[]}});
    const operationId=randomUUID();
    const initial=await call("run_script",{runtime:"node",taskId:task.taskId,operationId,script:"process.stdout.write('한'.repeat(40000));setTimeout(()=>{},1500)",yieldTimeMs:0,maxOutputBytes:16384});
    expect(initial.isError).not.toBe(true);
    const sessionId=initial.structuredContent.sessionId;
    await new Promise(resolve=>setTimeout(resolve,100));
    let result=(await call("read_process",{sessionId,afterSeq:initial.structuredContent.nextSeq,waitMode:"terminal",waitMs:30000,drainOnly:true,maxOutputBytes:16384})).structuredContent;
    let output=initial.structuredContent.stdout+result.stdout;
    expect(result).toMatchObject({running:true,hasMore:true,nextCall:{arguments:{waitMode:"terminal",waitMs:30000,drainOnly:true,maxOutputBytes:16384}}});
    let drains=0;
    while(result.hasMore) {
      const next=result.nextCall;const response=await call(next.tool,next.arguments);expect(response.isError).not.toBe(true);
      result=response.structuredContent;output+=result.stdout;drains++;
    }
    expect(drains).toBeGreaterThan(1);
    expect(result).toMatchObject({running:true,nextCall:{arguments:{waitMode:"terminal",waitMs:30000,drainOnly:false}}});
    const start=performance.now();
    result=(await call(result.nextCall.tool,result.nextCall.arguments)).structuredContent;output+=result.stdout;
    expect(performance.now()-start).toBeGreaterThan(100);
    expect(result).toMatchObject({completed:true,persistenceVerification:"verified",hasMore:false,droppedOutputBytes:0});
    expect(Buffer.byteLength(output)).toBe(120000);
    expect(createHash("sha256").update(output).digest("hex")).toBe(createHash("sha256").update("한".repeat(40000)).digest("hex"));
    expect(output).not.toContain("�");
    // Intentional reread keeps the old meaning of afterSeq=0.
    const reread=(await call("read_process",{sessionId,afterSeq:0,waitMs:0,maxOutputBytes:16384})).structuredContent;
    expect(reread.stdout).toBe(output.slice(0,reread.stdout.length));
    const identity=await services.continuityService.workspaceIdentity.resolve(root);
    const receiptFile=path.join(root,"state","workspaces",identity.workspaceId,"executions",`${operationId}.json`);
    const before=await readFile(receiptFile,"utf8");
    await new Promise(resolve=>setTimeout(resolve,1100));
    const unknown=await call("read_process",{sessionId,waitMs:0});expect(unknown.structuredContent.code).toBe("process_session_unknown");
    const recovered=await call("read_process",{sessionId,taskId:task.taskId,operationId,waitMs:0});
    expect(recovered.isError).not.toBe(true);
    expect(recovered.structuredContent).toMatchObject({completed:true,exitCode:0,executionState:"exited",persistenceVerification:"verified",outputAvailability:"unavailable"});
    expect(recovered.structuredContent).not.toHaveProperty("hasMore");
    expect(await readFile(receiptFile,"utf8")).toBe(before);
    for (const ids of [{taskId:randomUUID(),operationId},{taskId:task.taskId,operationId:randomUUID()}]) {
      const invalid=await call("read_process",{sessionId,...ids,waitMs:0});expect(invalid.structuredContent.code).toBe("process_session_unknown");
    }
    const receipt=JSON.parse(before);
    await services.continuityService.store.writeExecution({...receipt,state:"unknown"});
    const uncertain=(await call("read_process",{sessionId,taskId:task.taskId,operationId,waitMs:0})).structuredContent;
    expect(uncertain).toMatchObject({completed:false,persistenceVerification:"pending",nextCall:{tool:"get_work_context"}});
    await services.continuityService.store.writeExecution({...receipt,bootId:randomUUID()});
    expect((await call("read_process",{sessionId,taskId:task.taskId,operationId,waitMs:0})).structuredContent.code).toBe("process_session_unknown");
    expect(services.processManager.list()).toHaveLength(0);
  } finally {await server.close();await rm(root,{recursive:true,force:true});}
},10000);
