import {randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import path from 'node:path';
import {loadConfig} from '../dist/src/config.js';
import {createServices} from '../dist/src/mcp-server.js';
import {startHttpServer} from '../dist/src/http-server.js';
const [phase,root='/proof-state']=process.argv.slice(2);
if(!['prepare','old','candidate'].includes(phase))throw new Error('Use prepare, old or candidate');
const cwd=path.join(root,'workspace');await mkdir(cwd,{recursive:true});
const config=loadConfig({MCP_AUTH_TOKEN:'isolated-proof',MCP_BUILD_ID:process.env.MCP_BUILD_ID,MCP_DEFAULT_CWD:cwd,MCP_CONTINUITY_STATE_DIR:path.join(root,'continuity')},cwd);
config.host='127.0.0.1';config.port=0;
const service=createServices(config);let server;
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
try{
  if(phase==='prepare'){
    const task=await service.continuityService.create({cwd,requestId:randomUUID(),objective:'rollback compatibility',checkpoint:{phase:'test',current:'verify old image',completed:[],remaining:[],changedPaths:[],evidenceRefs:[],blockers:[]}});
    const first=(await service.executionRecorder.prepare({cwd,taskId:task.taskId,operationId:randomUUID(),toolKind:'run_script',semanticInput:{terminal:true}})).record;
    await service.executionRecorder.markSpawnFailed(first);
    const unsettled=(await service.executionRecorder.prepare({cwd,taskId:task.taskId,operationId:randomUUID(),toolKind:'run_script',semanticInput:{unsettled:true}})).record;
    await service.executionRecorder.markRunning(unsettled,randomUUID());
    await writeFile(path.join(root,'fixture.json'),JSON.stringify({taskId:task.taskId,workspaceId:first.workspaceId,terminalId:first.operationId,unsettledId:unsettled.operationId,candidateBuildId:config.buildId}));
    console.log(JSON.stringify({phase,status:'passed',buildId:config.buildId,receiptSchema:2}));
  }else{
    const fixture=JSON.parse(await readFile(path.join(root,'fixture.json'),'utf8'));
    await service.continuityService.initialize();
    const store=service.continuityService.store;
    assert((await store.readExecution(fixture.workspaceId,fixture.terminalId))?.state==='spawn_failed','terminal receipt lost');
    const recovered=await store.readExecution(fixture.workspaceId,fixture.unsettledId);
    assert(recovered?.state==='unknown','previous boot was not recovered conservatively');
    if(phase==='old'){
      server=await startHttpServer(config,service);
      const response=await fetch(`http://127.0.0.1:${server.httpServer.address().port}/mcp`,{method:'POST',headers:{authorization:'Bearer isolated-proof','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_script',arguments:{runtime:'node',taskId:fixture.taskId,operationId:randomUUID(),script:"import{appendFileSync}from'node:fs';appendFileSync('old-effect','once\\n')",yieldTimeMs:3000}}})});
      const body=(await response.json()).result;assert(!body.isError&&body.structuredContent.exitCode===0,'old image execution failed');
      assert(await readFile(path.join(cwd,'old-effect'),'utf8')==='once\n','old image effect mismatch');
      await service.executionRecorder.reconcile(fixture.workspaceId,fixture.taskId,{operationId:fixture.unsettledId,resolution:'verified_no_retry',evidenceRefs:[],recordedAt:new Date().toISOString()});
    }else{
      assert(recovered.callerResolution?.resolution==='verified_no_retry','old recovery evidence lost');
      assert(await readFile(path.join(cwd,'old-effect'),'utf8')==='once\n','old execution was duplicated');
      await store.integrityScan();
    }
    const directory=path.join(root,'continuity','workspaces',fixture.workspaceId);
    assert(!(await readdir(directory)).some(name=>/index|generation/.test(name)),'persistent index created');
    console.log(JSON.stringify({phase,status:'passed',buildId:config.buildId,sourceCandidateBuildId:fixture.candidateBuildId,receiptSchema:2,unknownPreserved:true,executionRecovered:true}));
  }
}finally{if(server)await server.close();else{await service.processManager.shutdown();await service.continuityService.close();}}
