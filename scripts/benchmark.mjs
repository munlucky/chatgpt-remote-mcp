import { FileService } from '/opt/chatgpt-remote-mcp/dist/src/file-service.js';
import { successResult } from '/opt/chatgpt-remote-mcp/dist/src/tool-result.js';
const files=new FileService({defaultCwd:process.env.MCP_PROBE_CWD || '/opt/chatgpt-remote-mcp',maxChunkBytes:1048576,maxEditFileBytes:1048576,maxOutputBytes:1048576});
const ms=[];
for(let i=0;i<35;i++){const start=performance.now();await files.listDirectory('src',undefined);if(i>=5)ms.push(performance.now()-start);}
ms.sort((a,b)=>a-b);
const data=await files.readFileChunk('src/config.ts',undefined,0,4096,'utf8');
console.log(JSON.stringify({kind:'synthetic-fixed-workload',samples:ms.length,listP50Ms:ms[14],listP95Ms:ms[28],responseBytes:Buffer.byteLength(JSON.stringify(successResult(data)))}));
