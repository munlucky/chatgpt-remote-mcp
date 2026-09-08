import { execFileSync } from 'node:child_process';

execFileSync(process.execPath, ['scripts/check-public-config.mjs'], { stdio: 'inherit' });
const buildId = execFileSync(process.execPath, ['scripts/build-id.mjs'], { encoding: 'utf8' }).trim();
execFileSync('docker', ['build', '--target', 'development', '--build-arg', `MCP_BUILD_ID=${buildId}`, '-t', 'chatgpt-remote-mcp:verify', '.'], { stdio: 'inherit' });
execFileSync('docker', [
  'run', '--rm', '--entrypoint', '/bin/bash', '-w', '/opt/chatgpt-remote-mcp',
  'chatgpt-remote-mcp:verify', '-c',
  'nginx -t && npm run typecheck && npm test && npm run build && npm audit --omit=dev && node scripts/benchmark-http.mjs',
], { stdio: 'inherit' });
console.log(JSON.stringify({
  verified: true,
  buildId,
  checks: ['nginx-config', 'typecheck', 'full-test-suite', 'build', 'production-audit', 'benchmark'],
}));
// Live source/image parity is a separate post-deployment check, never an implicit deployment prerequisite.
if (process.argv.includes('--live') || process.env.MCP_VERIFY_LIVE === '1') {
  execFileSync(process.execPath, ['scripts/verify-live.mjs'], { stdio: 'inherit' });
}
