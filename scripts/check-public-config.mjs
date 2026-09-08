import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
if(manifest.name!=='chatgpt-remote-mcp' || lock.name!==manifest.name || lock.packages[''].name!==manifest.name)throw new Error('Package identity is inconsistent');
execFileSync('git',['check-ignore','--quiet','.env']);
const env=Object.fromEntries(readFileSync('.env','utf8').split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l)).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')]}));
const privateKeys=['MCP_PUBLIC_URL','SHARED_PATH','HOST_USER_HOME','CODEX_PROFILE_PATH','CODEX_PROFILE_TARGET','KERNEL_PROFILE_PATH','KERNEL_PROFILE_TARGET','HOST_HOME_ALIAS','HOST_HOME_SECONDARY_ALIAS','MCP_STATE_VOLUME','MCP_USAGE_VOLUME','MCP_HOME_VOLUME','MCP_PROBE_CWD','CLOUDFLARE_TUNNEL_TOKEN','MCP_OAUTH_APPROVAL_KEY','MCP_AUTH_TOKEN'];
const example=readFileSync('.env.example','utf8');
const values=privateKeys.map(k=>env[k]).filter(v=>v && v.length>=8 && !example.includes(v));
const files=[...new Set(execFileSync('git',['ls-files','-co','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean))];
const findings=[];
for(const file of files){
  const text=readFileSync(file,'utf8');
  if(values.some(v=>text.toLowerCase().includes(v.toLowerCase())))findings.push(file);
}
if(findings.length)throw new Error(`Private configuration found in public files: ${findings.join(', ')}`);
console.log(JSON.stringify({publicConfigVerified:true,filesScanned:files.length,packageName:manifest.name,envIgnored:true}));
