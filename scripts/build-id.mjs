import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] || '.');
const hash = createHash('sha256');
const directories = ['src', 'test', 'scripts', 'templates'];
const files = ['Dockerfile', 'docker-compose.yml', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts'];

function stableCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalText(file) {
  return readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
}

function addFile(relative) {
  const absolute = path.join(root, relative);
  hash.update(relative.replaceAll('\\', '/')).update('\0').update(canonicalText(absolute)).update('\0');
}

function visit(relative) {
  const absolute = path.join(root, relative);
  if (!statSync(absolute).isDirectory()) throw new Error(`Build-id input is not a directory: ${relative}`);
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => stableCompare(a.name, b.name))) {
    const file = path.posix.join(relative.replaceAll('\\', '/'), entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.isFile()) addFile(file);
  }
}

for (const directory of directories) visit(directory);
for (const file of files) addFile(file);
console.log(`src-${hash.digest('hex').slice(0, 20)}`);
