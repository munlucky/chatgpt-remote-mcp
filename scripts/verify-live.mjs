import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';

const projectRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
process.chdir(projectRoot);

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const buildId = execFileSync(process.execPath, ['scripts/build-id.mjs'], { encoding: 'utf8' }).trim();
const container = execFileSync('docker', ['compose', 'ps', '-q', 'workmachine'], { encoding: 'utf8' }).trim();
if (!container) throw new Error('MCP service is not running');

const inspect = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0];
const env = Object.fromEntries(inspect.Config.Env.map((value) => {
  const index = value.indexOf('=');
  return [value.slice(0, index), value.slice(index + 1)];
}));
const maxRegisteredClients = Number(env.MCP_OAUTH_MAX_REGISTERED_CLIENTS);
if (
  env.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS !== '3600' ||
  env.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS !== '2592000' ||
  env.MCP_TRUST_PROXY_HOPS !== '1' ||
  !env.MCP_PROBE_SECRET ||
  !Number.isSafeInteger(maxRegisteredClients) ||
  maxRegisteredClients < 1 ||
  maxRegisteredClients > 10_000
) {
  throw new Error('Live OAuth, proxy, or probe configuration does not satisfy the deployment policy');
}

const source = realpathSync(inspect.Config.Labels['com.docker.compose.project.working_dir']);
if (source !== projectRoot) throw new Error('Live Compose project is not the target project');
if (inspect.Config.Labels['org.opencontainers.image.revision'] !== buildId) {
  throw new Error('Live image differs from current source digest');
}

const helperCheck = spawnSync(process.execPath, ['scripts/sync-commit-helper.mjs', '--check'], { encoding: 'utf8' });
if (helperCheck.error) throw helperCheck.error;
const helper = helperCheck.stdout.trim() ? JSON.parse(helperCheck.stdout) : { enabled: false, matched: false };
if (helperCheck.status !== 0 || !helper.matched) throw new Error('Managed commit helper differs from the repository source');
let runtimeHelperVerified = false;
if (helper.enabled) {
  const runtimeTarget = env.MCP_COMMIT_HELPER_TARGET;
  if (!runtimeTarget || runtimeTarget !== helper.target) throw new Error('Runtime commit helper target differs from deployment configuration');
  const runtimeHash = execFileSync('docker', [
    'exec', container, 'node', '-e',
    "const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');process.stdout.write(createHash('sha256').update(readFileSync(process.env.MCP_COMMIT_HELPER_TARGET)).digest('hex'))",
  ], { encoding: 'utf8' }).trim();
  const sourceHash = sha256('scripts/mcp-kernel-commit.mjs');
  if (runtimeHash !== sourceHash) throw new Error('Runtime commit helper content differs from repository source');
  runtimeHelperVerified = true;
}

const result = JSON.parse(execFileSync('docker', ['exec', container, 'node', '/opt/chatgpt-remote-mcp/scripts/live-probe.mjs'], { encoding: 'utf8' }));
if (
  result.buildId !== buildId ||
  !result.telemetry.enabled ||
  result.telemetry.writeFailures ||
  result.telemetry.droppedEvents
) {
  throw new Error('Live build or telemetry check failed');
}

console.log(JSON.stringify({
  ...result,
  composeProjectVerified: true,
  sourceDigestVerified: true,
  oauthAccessTtlSeconds: 3600,
  oauthRefreshTtlSeconds: 2592000,
  oauthMaxRegisteredClients: maxRegisteredClients,
  proxyTrustHops: 1,
  probeSecretConfigured: true,
  commitHelperVerified: helper.enabled ? runtimeHelperVerified : null,
}));
