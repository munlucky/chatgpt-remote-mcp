import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
const base = 'http://127.0.0.1:3000';
const publicBase = process.env.MCP_PUBLIC_URL;
const probeCwd = process.env.MCP_PROBE_CWD || '/opt/chatgpt-remote-mcp';
const preflight = process.argv.includes('--preflight');
const resource = `${publicBase}/mcp`;
const redirect = 'http://127.0.0.1:32123/callback';
const clientName = 'MCP deployment probe';
const request = async (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000), redirect: 'manual' });
async function checked(response, status) { if(response.status !== status) throw new Error(`Probe HTTP status ${response.status}; expected ${status}`); return response; }
const state = JSON.parse(await readFile(process.env.MCP_OAUTH_STATE_FILE || '/var/lib/chatgpt-remote-mcp/oauth-state.json', 'utf8'));
let client = Object.values(state.clients).find(c => c.client_name === clientName && c.redirect_uris.includes(redirect) && c.token_endpoint_auth_method === 'none');
if (!client) client = await (await checked(await request(`${base}/register`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ client_name:clientName, redirect_uris:[redirect], token_endpoint_auth_method:'none', grant_types:['authorization_code','refresh_token'], response_types:['code'], scope:'mcp:tools' }) }),201)).json();
const verifier = randomBytes(48).toString('base64url');
const key = process.env.MCP_OAUTH_APPROVAL_KEY || (await readFile(process.env.MCP_OAUTH_APPROVAL_KEY_FILE || '/var/lib/chatgpt-remote-mcp/oauth-approval-key','utf8')).trim();
const auth = await checked(await request(`${base}/authorize`, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'}, body:new URLSearchParams({client_id:client.client_id,redirect_uri:redirect,response_type:'code',code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:'mcp:tools',resource,access_key:key})}),303);
const code = new URL(auth.headers.get('location')).searchParams.get('code');
const tokens = await (await checked(await request(`${base}/token`, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code,code_verifier:verifier,redirect_uri:redirect,resource})}),200)).json();
let id = 0;
const call = async (name,args={},origin=base) => {
  const started=performance.now();
  const response=await checked(await request(`${origin}/mcp`,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:`Bearer ${tokens.access_token}`,'x-mcp-probe':'1'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method:'tools/call',params:{name,arguments:args}})}),200);
  const text=await response.text();const body=JSON.parse(text);
  if(body.error || body.result?.isError) throw new Error(`Probe tool failed: ${name}`);
  return {ms:performance.now()-started,bytes:Buffer.byteLength(text),data:body.result.structuredContent};
};
try {
  const processes=await call('list_processes');
  const entries = processes.data.processes;
  if (!Array.isArray(entries)) throw new Error('Unexpected process listing');
  const active = entries.filter(p=>p.running).length;
  if(preflight){ console.log(JSON.stringify({preflight:true,activeManagedProcesses:active})); if(active)process.exitCode=2; }
  else {
    const health=await (await checked(await request(`${publicBase}/health`),200)).json();
    const unauthorized=await request(`${publicBase}/mcp`,{method:'POST',headers:{'content-type':'application/json','x-mcp-probe':'1'},body:'{}'});
    if(unauthorized.status!==401)throw new Error('Unauthenticated request was not rejected');
    const listing=[];for(let i=0;i<10;i++)listing.push((await call('list_directory',{path:'src',cwd:probeCwd})).ms);
    const batch=await call('read_files',{paths:['src/config.ts','src/http-server.ts','src/file-service.ts'],cwd:probeCwd,maxBytesPerFile:1024},publicBase);
    if(batch.data.count!==3 || batch.data.files.some(f=>f.error))throw new Error('Batch probe failed');
    const p=(a,q)=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*q)-1];
    console.log(JSON.stringify({healthy:health.status==='ok',buildId:health.buildId,telemetry:health.telemetry,oauthAuthenticated:true,publicMcpAuthenticated:true,unauthenticatedStatus:unauthorized.status,batchCount:batch.data.count,batchPublicMs:batch.ms,batchResponseBytes:batch.bytes,listDirectory:{samples:listing.length,p50Ms:p(listing,.5),p95Ms:p(listing,.95)},activeManagedProcesses:active}));
  }
} finally {
  for(const token of [tokens.access_token,tokens.refresh_token])if(token)await checked(await request(`${base}/revoke`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:client.client_id,token})}),200);
}
