import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.argv[2] || '.');
const hash = createHash('sha256');
function visit(relative) {
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) visit(file);
    else hash.update(file).update('\0').update(readFileSync(path.join(root, file))).update('\0');
  }
}
for (const dir of ['src', 'test', 'scripts', 'templates']) visit(dir);
for (const file of ['Dockerfile', 'docker-compose.yml', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']) hash.update(file).update(readFileSync(path.join(root,file)));
console.log(`src-${hash.digest('hex').slice(0,20)}`);
