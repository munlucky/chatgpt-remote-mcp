import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];
if (mode === '--write-fixture' || mode === '--read-fixture') {
  // Disposable volume only; never copy a live writer's directory.
  const { createServices } = await import('/opt/chatgpt-remote-mcp/dist/src/mcp-server.js');
  const { loadConfig } = await import('/opt/chatgpt-remote-mcp/dist/src/config.js');
  const root = '/rollback-state/workspace';
  await mkdir(root, { recursive: true });
  const services = createServices(loadConfig({ MCP_AUTH_TOKEN: 'synthetic', MCP_DEFAULT_CWD: root,
    MCP_CONTINUITY_STATE_DIR: '/rollback-state/state' }, root));
  const service = services.continuityService;
  const terminal = { phase: 'completed', current: 'synthetic verified', completed: [], remaining: [], blockers: [], changedPaths: [] };
  try {
    if (mode === '--write-fixture') {
      const fixtures = [];
      for (const withFinal of [true, false]) {
        const created = await service.create({ cwd: root, requestId: randomUUID(), objective: 'rollback synthetic', checkpoint: { ...terminal, evidenceRefs: [] } });
        const input = { taskId: created.taskId, requestId: randomUUID(), expectedRevision: 1, outcome: 'completed', summary: 'synthetic verified', evidenceRefs: [],
          ...(withFinal ? { finalCheckpoint: terminal } : {}) };
        const result = await service.complete(input);
        fixtures.push({ input, result });
      }
      await writeFile('/rollback-state/fixture.json', JSON.stringify(fixtures));
    } else {
      const fixtures = JSON.parse(await readFile('/rollback-state/fixture.json', 'utf8'));
      for (const { input, result } of fixtures) {
        const context = await service.context({ taskId: input.taskId, format: 'full' });
        assert.equal(context.task.status, 'completed');
        assert.equal(context.task.checkpoint.phase, 'completed');
        assert.deepEqual(context.task.checkpoint.remaining, []);
        if (!input.finalCheckpoint) assert.deepEqual(await service.complete(input), result);
        else await assert.rejects(() => service.complete(input), { code: 'idempotency_conflict' });
      }
      const created = await service.create({ cwd: root, requestId: randomUUID(), objective: 'old-image write', checkpoint: { ...terminal, evidenceRefs: [] } });
      await service.complete({ taskId: created.taskId, requestId: randomUUID(), expectedRevision: 1, outcome: 'completed', summary: 'old image write verified', evidenceRefs: [] });
      const identity = await service.workspaceIdentity.resolve(root);
      const state = await service.store.readWorkspace(identity);
      assert.equal(state.schemaVersion, 2); assert.equal(state.activeTaskId, null);
      console.log(JSON.stringify({ previousImageReadVerified: true, previousImageWriteVerified: true, omittedInputReplayVerified: true,
        newFinalInputReplay: 'idempotency_conflict-no-mutation', schemaVersion: state.schemaVersion }));
    }
  } finally { await services.processManager.shutdown(); await service.close(); }
} else {
  const arg = flag => process.argv[process.argv.indexOf(flag) + 1];
  const image = process.argv.includes('--image') ? arg('--image') : null;
  const previous = process.argv.includes('--previous-image') ? arg('--previous-image') : null;
  if (!image || !previous) throw new Error('Use --image CANDIDATE --previous-image IMMUTABLE_IMAGE');
  const volume = `mcp-rollback-${randomUUID()}`;
  const script = fileURLToPath(import.meta.url);
  const docker = args => execFileSync('docker', args, { encoding: 'utf8' }).trim();
  docker(['volume', 'create', volume]);
  try {
    const run = (target, action) => docker(['run', '--rm', '--entrypoint', 'node', '--mount', `type=volume,source=${volume},target=/rollback-state`,
      '--mount', `type=bind,source=${script},target=/tmp/verify-rollback.mjs,readonly`, target, '/tmp/verify-rollback.mjs', action]);
    run(image, '--write-fixture');
    console.log(run(previous, '--read-fixture'));
  } finally { docker(['volume', 'rm', volume]); }
}
