import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
const source=path.resolve(process.argv[2]??'.');
const sourceBuildId=execFileSync(process.execPath,[path.join(source,'scripts/build-id.mjs'),source],{encoding:'utf8'}).trim();
const load=file=>import(pathToFileURL(path.join(source,'dist/src',file)).href);
const [{loadConfig},{createServices},{startHttpServer}]=await Promise.all([load('config.js'),load('mcp-server.js'),load('http-server.js')]);
const fixture={samples:3,intervalMs:100,writes:8,bytesPerWrite:30000,maxOutputBytes:16384,initialYieldMs:0};
const rows=[];
for(const policy of [{waitMode:'output',waitMs:1000},{waitMode:'terminal',waitMs:30000}]) {
  const samples=[];
  for(let sample=0;sample<fixture.samples;sample++) {
    const root=await mkdtemp(path.join(os.tmpdir(),'mcp-poll-comparison-'));
    const config=loadConfig({MCP_AUTH_TOKEN:'fixture',MCP_DEFAULT_CWD:root,MCP_CONTINUITY_STATE_DIR:path.join(root,'state')},root);
    config.host='127.0.0.1';config.port=0;
    const services=createServices(config),server=await startHttpServer(config,services);
    const endpoint=`http://127.0.0.1:${server.httpServer.address().port}/mcp`;
    let calls=0,zeroWait=0,responseBytes=0,returnedBytes=0,firstOutputMs=null,output='',spawnCount=0;
    const begin=performance.now();
    const call=async(name,args)=>{
      calls++;if(name==='read_process'&&(args.drainOnly||args.waitMs===0))zeroWait++;
      if(name==='run_script')spawnCount++;
      const response=await fetch(endpoint,{method:'POST',headers:{authorization:'Bearer fixture','content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
      const text=await response.text();responseBytes+=Buffer.byteLength(text);
      const body=JSON.parse(text).result;if(body.isError)throw new Error('fixture_call_failed');
      const result=body.structuredContent;const chunk=(result.stdout??'')+(result.stderr??'');
      returnedBytes+=Buffer.byteLength(chunk);output+=chunk;
      if(chunk&&firstOutputMs===null)firstOutputMs=performance.now()-begin;
      return result;
    };
    try {
      const script=`let n=0;const timer=setInterval(()=>{process.stdout.write('x'.repeat(${fixture.bytesPerWrite}));if(++n===${fixture.writes})clearInterval(timer)},${fixture.intervalMs});`;
      let result=await call('run_script',{runtime:'node',script,yieldTimeMs:0,maxOutputBytes:fixture.maxOutputBytes});
      let first=true;
      while(result.running||result.hasMore) {
        if(calls>1000)throw new Error('polling_did_not_terminate');
        const next=first?{tool:'read_process',arguments:{sessionId:result.sessionId,afterSeq:result.nextSeq,...policy,maxOutputBytes:fixture.maxOutputBytes}}:result.nextCall;
        first=false;if(!next)throw new Error('continuation_missing');
        result=await call(next.tool,next.arguments);
      }
      if(output!=='x'.repeat(fixture.writes*fixture.bytesPerWrite))throw new Error('output_mismatch');
      samples.push({calls,zeroWait,responseBytes,returnedBytes,generatedBytes:fixture.writes*fixture.bytesPerWrite,droppedBytes:result.droppedOutputBytes,aborted:0,spawnCount,firstOutputMs,terminalObservedMs:performance.now()-begin});
    }finally{await server.close();await rm(root,{recursive:true,force:true});}
  }
  rows.push({policy,samples});
}
console.log(JSON.stringify({schemaVersion:1,sourceBuildId,environment:{platform:process.platform,node:process.version},fixture,fixtureDigest:createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),rows,note:'A: compare the same policy across source builds. B: compare policies within the candidate. nextCall is executed verbatim after the first explicit read. Timing measures caller observation, not process runtime.'},null,2));
