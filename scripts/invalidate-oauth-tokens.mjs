import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const file = args.find(arg => !arg.startsWith('--'));
if (!file) throw new Error('Usage: node scripts/invalidate-oauth-tokens.mjs STATE_FILE [--apply --confirm-server-stopped]');
const state = JSON.parse(await readFile(file, 'utf8'));
if (state.version !== 1 || !state.clients || typeof state.clients !== 'object' || Array.isArray(state.clients)
  || !state.tokens || typeof state.tokens !== 'object' || Array.isArray(state.tokens)) throw new Error('Invalid OAuth state');
const count = Object.keys(state.tokens).length;
if (!args.includes('--apply')) {
  console.log(JSON.stringify({ dryRun: true, tokensToInvalidate: count, clientsPreserved: Object.keys(state.clients).length }));
} else {
  if (!args.includes('--confirm-server-stopped')) throw new Error('Stop the MCP server first, then explicitly pass --confirm-server-stopped; a running server can overwrite offline changes.');
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ ...state, tokens: {} }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(temporary, file);
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  console.log(JSON.stringify({ invalidatedTokens: count, clientsPreserved: Object.keys(state.clients).length }));
}
