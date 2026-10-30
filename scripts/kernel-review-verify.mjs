import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// The project's process suite assumes a clean Linux login shell. Build the
// existing development target, whose checks run typecheck, the full suite and
// build. This never restarts or replaces the running service.
const tag = `moonremote-kernel-review-check:${randomUUID()}`;
try {
  execFileSync('docker', ['build', '--target', 'development', '--tag', tag, '.'], { stdio: 'inherit' });
} finally {
  try { execFileSync('docker', ['image', 'rm', '--force', tag], { stdio: 'ignore' }); }
  catch { /* Preserve the original verification result if tag cleanup fails. */ }
}
if (process.argv.includes('--live') || process.env.MCP_KERNEL_REVIEW_LIVE_VERIFY === '1') {
  // Docker's successful build does not refresh the host's dist directory.
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'], { stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/kernel-review-smoke.mjs'], { stdio: 'inherit' });
}
