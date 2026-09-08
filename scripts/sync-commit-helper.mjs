import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const checkOnly = process.argv.includes('--check');
const envFile = path.join(projectRoot, '.env');

function dotenv() {
  const values = {};
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function digest(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const env = dotenv();
const containerTarget = env.MCP_COMMIT_HELPER_TARGET || '';
if (!containerTarget) {
  console.log(JSON.stringify({ enabled: false, matched: true }));
  process.exit(0);
}
if (!containerTarget.startsWith('/shared/')) {
  throw new Error('MCP_COMMIT_HELPER_TARGET must be under /shared for managed synchronization');
}
if (!env.SHARED_PATH) throw new Error('SHARED_PATH is required when MCP_COMMIT_HELPER_TARGET is enabled');

const source = path.join(projectRoot, 'scripts', 'mcp-kernel-commit.mjs');
const relativeTarget = containerTarget.slice('/shared/'.length).split('/').filter(Boolean);
const target = path.join(env.SHARED_PATH, ...relativeTarget);
const sourceHash = digest(source);
let targetHash = existsSync(target) ? digest(target) : undefined;

if (!checkOnly && targetHash !== sourceHash) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
  targetHash = digest(target);
}
const result = { enabled: true, matched: targetHash === sourceHash, target: containerTarget, sourceHash };
if (!result.matched) process.exitCode = 2;
console.log(JSON.stringify(result));
