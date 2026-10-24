import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// The core suite exercises POSIX process groups and /bin/bash. Keep Windows
// verification isolated from the running workmachine and its credentials/state.
const args = process.argv.slice(2);
let result;
if (process.platform === 'win32') {
  const source = fileURLToPath(new URL('..', import.meta.url));
  result = spawnSync('docker', ['run','--rm','--name',`mcp-core-${randomUUID().slice(0,8)}`,
    '--entrypoint','bash','-v',`${source}:/input:ro`, process.env.MCP_TEST_IMAGE || 'chatgpt-remote-mcp:local', '-lc',
    'set -eu; mkdir -p /tmp/mcp-core; cp /input/package.json /input/package-lock.json /input/tsconfig.json /input/vitest.config.ts /input/Dockerfile /input/docker-compose.yml /input/README.md /tmp/mcp-core/; cp -r /input/src /input/scripts /input/test /input/templates /tmp/mcp-core/; cd /tmp/mcp-core; npm ci --include=dev --ignore-scripts --no-audit --no-fund; node node_modules/vitest/vitest.mjs run "$@"', 'mcp-core', ...args],
    { stdio: 'inherit', windowsHide: true });
} else {
  result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs','run',...args], { stdio: 'inherit' });
}
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
