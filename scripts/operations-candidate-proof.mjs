import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
if(!process.argv.includes('--inside')){
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-compose-proof-'));
  try{
    const required={MCP_PUBLIC_URL:'https://candidate.invalid',CODEX_PROFILE_TARGET:'/profile/codex',KERNEL_PROFILE_TARGET:'/profile/kernel',SHARED_PATH:root,HOST_USER_HOME:root,CODEX_PROFILE_PATH:root,KERNEL_PROFILE_PATH:root,CLOUDFLARE_TUNNEL_TOKEN:'isolated-placeholder',MCP_STATE_VOLUME:'isolated-state',MCP_USAGE_VOLUME:'isolated-usage',MCP_HOME_VOLUME:'isolated-home',MCP_DEFAULT_PROCESS_YIELD_MS:'3000',MCP_PROCESS_READ_WAIT_MAX_MS:'30000'};
    const file=path.join(root,'candidate.env');await writeFile(file,Object.entries(required).map(([key,value])=>`${key}=${value.replaceAll('\\','/')}`).join('\n'));
    const compose=JSON.parse(execFileSync('docker',['compose','--env-file',file,'config','--format','json'],{encoding:'utf8',env:{...process.env,...required}}));
    const settings=compose.services.workmachine.environment;
    assert.equal(settings.MCP_DEFAULT_PROCESS_YIELD_MS,'3000');assert.equal(settings.MCP_PROCESS_READ_WAIT_MAX_MS,'30000');
    const image=process.env.MCP_CANDIDATE_IMAGE??'chatgpt-remote-mcp:verify';
    const sourceBuildId=execFileSync(process.execPath,['scripts/build-id.mjs'],{encoding:'utf8'}).trim();
    const imageBuildId=execFileSync('docker',['image','inspect',image,'--format','{{index .Config.Labels "org.opencontainers.image.revision"}}'],{encoding:'utf8'}).trim();
    assert.equal(imageBuildId,sourceBuildId,'candidate source/image parity');
    const args=['run','--rm','--entrypoint','node','-w','/opt/chatgpt-remote-mcp','-e','MCP_OAUTH_ENABLED=false','-e','MCP_AUTH_TOKEN=isolated-proof','-e','MCP_EXECUTION_TRACKING=required'];
    for(const key of ['MCP_DEFAULT_PROCESS_YIELD_MS','MCP_PROCESS_READ_WAIT_MAX_MS'])args.push('-e',`${key}=${settings[key]}`);
    args.push(image,'scripts/operations-candidate-proof.mjs','--inside');
    const proof=JSON.parse(execFileSync('docker',args,{encoding:'utf8'}));
    assert.equal(proof.buildId,sourceBuildId);
    console.log(JSON.stringify({status:'passed',sourceBuildId,imageBuildId,composeSettings:{yieldMs:3000,readCapMs:30000},...proof},null,2));
  }finally{await rm(root,{recursive:true,force:true});}
}else{
  const [{loadConfig},{createServices},{startHttpServer}]=await Promise.all([import('../dist/src/config.js'),import('../dist/src/mcp-server.js'),import('../dist/src/http-server.js')]);
  const root=await mkdtemp(path.join(os.tmpdir(),'mcp-candidate-proof-'));
  const config=loadConfig({...process.env,MCP_DEFAULT_CWD:root,MCP_CONTINUITY_STATE_DIR:path.join(root,'state')},root);
  config.host='127.0.0.1';config.port=0;
  const services=createServices(config),server=await startHttpServer(config,services);
  const endpoint=`http://127.0.0.1:${server.httpServer.address().port}`;
  const headers={authorization:'Bearer isolated-proof','content-type':'application/json',accept:'application/json, text/event-stream'};
  const rpc=async(method,params)=>{
    const response=await fetch(`${endpoint}/mcp`,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});return(await response.json()).result;
  };
  const call=(name,args)=>rpc('tools/call',{name,arguments:args});
  try{
    const diagnostics=await(await fetch(`${endpoint}/diagnostics`,{headers})).json();
    assert.deepEqual(diagnostics.processSettings,{defaultYieldMs:3000,readWaitMaxMs:30000});
    const catalog=await rpc('tools/list');const read=catalog.tools.find(tool=>tool.name==='read_process');
    for(const field of ['drainOnly','taskId','operationId'])assert.ok(read.inputSchema.properties[field]);
    const rejected=await call('run_script',{runtime:'node',script:'process.exit(0)'});
    assert.equal(rejected.structuredContent.code,'tracking_required');assert.equal(services.processManager.list().length,0);
    const task=await services.continuityService.create({cwd:root,requestId:crypto.randomUUID(),objective:'candidate parity',checkpoint:{phase:'test',current:'verify',completed:[],remaining:[],changedPaths:[],evidenceRefs:[],blockers:[]}});
    const begin=performance.now();
    const started=await call('run_script',{runtime:'node',taskId:task.taskId,operationId:crypto.randomUUID(),script:'setTimeout(()=>{},4000)'});
    const defaultElapsedMs=performance.now()-begin;assert.ok(defaultElapsedMs>=2900&&defaultElapsedMs<3900);assert.equal(started.structuredContent.running,true);
    const terminal=await call('read_process',{sessionId:started.structuredContent.sessionId,taskId:task.taskId,operationId:started.structuredContent.operationId,waitMode:'terminal',waitMs:300000});
    assert.equal(terminal.structuredContent.effectiveWaitMs,30000);assert.equal(terminal.structuredContent.persistenceVerification,'verified');
    const overrideStart=performance.now();
    const override=await call('run_script',{runtime:'node',taskId:task.taskId,operationId:crypto.randomUUID(),script:'setTimeout(()=>{},1000)',yieldTimeMs:0});
    const overrideElapsedMs=performance.now()-overrideStart;assert.ok(overrideElapsedMs<1000);assert.equal(override.structuredContent.running,true);
    const immediate=await call('read_process',{sessionId:override.structuredContent.sessionId,waitMs:0});assert.equal(immediate.structuredContent.effectiveWaitMs,0);
    console.log(JSON.stringify({status:'passed',buildId:diagnostics.buildId,processSettings:diagnostics.processSettings,trackingRequired:true,catalogFields:true,defaultElapsedMs,overrideElapsedMs,readCapEffectiveMs:terminal.structuredContent.effectiveWaitMs,wireZeroImmediate:true}));
  }finally{await server.close();await rm(root,{recursive:true,force:true});}
}
