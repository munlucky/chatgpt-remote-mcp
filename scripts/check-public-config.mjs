import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
if (manifest.name !== 'chatgpt-remote-mcp' || lock.name !== manifest.name || lock.packages[''].name !== manifest.name) {
  throw new Error('Package identity is inconsistent');
}
execFileSync('git', ['check-ignore', '--quiet', '.env']);
const env = Object.fromEntries(readFileSync('.env', 'utf8').split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
  const index = line.indexOf('=');
  return [line.slice(0, index), line.slice(index + 1).replace(/^['"]|['"]$/g, '')];
}));
const privateKeys = [
  'MCP_PUBLIC_URL', 'SHARED_PATH', 'HOST_USER_HOME', 'CODEX_PROFILE_PATH', 'CODEX_PROFILE_TARGET',
  'KERNEL_PROFILE_PATH', 'KERNEL_PROFILE_TARGET', 'HOST_HOME_ALIAS', 'HOST_HOME_SECONDARY_ALIAS',
  'MCP_STATE_VOLUME', 'MCP_USAGE_VOLUME', 'MCP_HOME_VOLUME', 'MCP_PROBE_CWD', 'CLOUDFLARE_TUNNEL_TOKEN',
  'MCP_OAUTH_APPROVAL_KEY', 'MCP_AUTH_TOKEN', 'MCP_PROBE_SECRET',
];
const example = readFileSync('.env.example', 'utf8');
const compose = readFileSync('docker-compose.yml', 'utf8');
const dockerfile = readFileSync('Dockerfile', 'utf8');
if (
  !compose.includes('MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS:-3600') ||
  !compose.includes('MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS:-2592000') ||
  !compose.includes('MCP_OAUTH_MAX_REGISTERED_CLIENTS:-256') ||
  !example.includes('MCP_OAUTH_MAX_REGISTERED_CLIENTS=256')
) {
  throw new Error('Compose or example OAuth policy defaults drifted');
}
if (!/cloudflare\/cloudflared@sha256:[a-f0-9]{64}/.test(compose)) throw new Error('Cloudflare image must be pinned');
if (
  !dockerfile.includes('real_ip_header CF-Connecting-IP;') ||
  !dockerfile.includes('set_real_ip_from 127.0.0.1;') ||
  !dockerfile.includes('proxy_set_header X-Forwarded-For $remote_addr;') ||
  dockerfile.includes('$proxy_add_x_forwarded_for')
) {
  throw new Error('Nginx client-IP trust boundary drifted');
}
const values = privateKeys.map((key) => env[key]).filter((value) => value && value.length >= 8 && !example.includes(value));
const files = [...new Set(execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
const findings = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  if (values.some((value) => text.toLowerCase().includes(value.toLowerCase()))) findings.push(file);
}
if (findings.length) throw new Error(`Private configuration found in public files: ${findings.join(', ')}`);
console.log(JSON.stringify({
  publicConfigVerified: true,
  filesScanned: files.length,
  packageName: manifest.name,
  envIgnored: true,
  oauthPolicyVerified: true,
  proxyTrustBoundaryVerified: true,
}));
