import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createServices } from '../src/mcp-server.js';
import { startHttpServer } from '../src/http-server.js';
import { RemoteDevOAuthProvider } from '../src/oauth.js';

describe('review hardening', () => {
  it('reports per-request overhead separately from tool wait time and counts excluded probes', async () => {
    const dir=await mkdtemp(path.join(os.tmpdir(),'usage-report-'));
    const base={event:'mcp_request',timestamp:new Date().toISOString(),buildId:'fixture',toolName:'read_process',status:200,trafficClass:'usage'};
    try {
      await writeFile(path.join(dir,'requests.jsonl'),[
        {...base,durationMs:100,toolMs:10}, {...base,durationMs:200,toolMs:199},
        {...base,trafficClass:'probe',durationMs:999,toolMs:1},
      ].map(e=>JSON.stringify(e)).join('\n')+'\ninvalid\n');
      const report=JSON.parse(execFileSync(process.execPath,['scripts/usage-report.mjs',dir,'1'],{encoding:'utf8'}));
      expect(report).toMatchObject({samples:2,excludedProbes:1,malformed:1});
      expect(report.groups[0]).toMatchObject({overheadP95Ms:90,toolP95Ms:199});
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('warns about legacy TTL overrides and persisted long-lived tokens without revoking them', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(),'oauth-policy-'));
    const stateFile = path.join(dir,'oauth.json');
    const state = { version:1, clients:{}, tokens:{ hidden:{type:'access',clientId:'test',scopes:[],expiresAt:Date.now()+31536000000,resource:'http://localhost/mcp'} } };
    await writeFile(stateFile, JSON.stringify(state));
    const warn = vi.spyOn(console,'warn').mockImplementation(()=>{});
    const config = loadConfig({ MCP_OAUTH_ENABLED:'true', MCP_OAUTH_APPROVAL_KEY:'hidden-approval', MCP_PUBLIC_URL:'http://localhost', MCP_OAUTH_STATE_FILE:stateFile, MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS:'2592000' });
    config.port=0; config.host='127.0.0.1';
    const server = await startHttpServer(config,createServices(config));
    try {
      const provider = new RemoteDevOAuthProvider(config);
      await provider.clientsStore.getClient('missing');
      const messages = warn.mock.calls.flat().join(' ');
      expect(messages).toContain('configured TTL exceeds');
      expect(messages).toContain('persisted tokens outlive');
      expect(messages).not.toContain('hidden');
      expect(JSON.parse(await readFile(stateFile,'utf8'))).toEqual(state);
    } finally { warn.mockRestore(); await server.close(); await rm(dir,{recursive:true,force:true}); }
  });
  it.each([true, false])('keeps probe classification behind independent secret and MCP authentication (configured=%s)', async (configured) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'hardening-'));
    const config = loadConfig({ MCP_AUTH_TOKEN: 'private-bearer', MCP_PROBE_SECRET: configured ? 'private-probe' : undefined, MCP_USAGE_LOG_DIR: dir });
    config.host = '127.0.0.1'; config.port = 0;
    const server = await startHttpServer(config, createServices(config));
    const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/health`)).json()).toEqual({ status: 'ok' });
      expect((await fetch(`${base}/diagnostics`)).status).toBe(401);
      expect((await fetch(`${base}/diagnostics`, { headers: { 'x-mcp-probe-secret': 'private-probe' } })).status).toBe(401);
      const diagnostics = await fetch(`${base}/diagnostics`, { headers: { authorization: 'Bearer private-bearer' } });
      expect(diagnostics.headers.get('cache-control')).toBe('no-store');
      expect(await diagnostics.json()).toMatchObject({ status: 'ok', activeMcpRequests: 0 });
      const call = async (headers: Record<string,string>, authenticate = true) => {
        const response = await fetch(`${base}/mcp`, { method:'POST', headers: { 'content-type':'application/json', accept:'application/json, text/event-stream', ...(authenticate ? { authorization:'Bearer private-bearer' } : {}), ...headers }, body:JSON.stringify({ jsonrpc:'2.0', id:1, method:'tools/call', params:{name:'list_processes',arguments:{}} }) });
        await response.text(); return response.status;
      };
      expect(await call({'x-mcp-probe':'1'})).toBe(200);
      expect(await call({'x-mcp-probe-secret':'wrong'})).toBe(200);
      expect(await call({'x-mcp-probe-secret':'private-probe'})).toBe(200);
      expect(await call({'x-mcp-probe-secret':'private-probe'}, false)).toBe(401);
      await server.close();
      const raw = await readFile(path.join(dir,'requests.jsonl'),'utf8');
      expect(raw).not.toContain('private-');
      expect(raw.trim().split('\n').map(line=>JSON.parse(line).trafficClass)).toEqual(['usage','usage',configured ? 'probe' : 'usage','usage']);
    } finally { await server.close().catch(() => {}); await rm(dir,{recursive:true,force:true}); }
  });

  it('keeps TTL defaults aligned and migration dry run non-destructive', async () => {
    const config = loadConfig({ MCP_AUTH_TOKEN: 'test' });
    expect(config.oauthAccessTokenTtlSeconds).toBe(3600);
    expect(config.oauthRefreshTokenTtlSeconds).toBe(2592000);
    expect(config.oauthMaxRegisteredClients).toBe(256);
    const dir = await mkdtemp(path.join(os.tmpdir(),'token-migration-'));
    const file = path.join(dir,'state.json');
    const state = { version:1, clients:{ client:{client_id:'client'} }, tokens:{ secret:{type:'access'} } };
    try {
      await writeFile(file,JSON.stringify(state));
      const run = (...flags: string[]) => execFileSync(process.execPath,['scripts/invalidate-oauth-tokens.mjs',file,...flags],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
      expect(JSON.parse(run()).tokensToInvalidate).toBe(1);
      expect(JSON.parse(await readFile(file,'utf8'))).toEqual(state);
      expect(()=>run('--apply')).toThrow();
      expect(JSON.parse(await readFile(file,'utf8'))).toEqual(state);
      run('--apply','--confirm-server-stopped');
      expect(JSON.parse(await readFile(file,'utf8'))).toEqual({...state,tokens:{}});
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('keeps build identity stable across LF/CRLF checkouts and changes it for source changes', async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), 'build-id-'));
    const createFixture = async (name: string, eol: string) => {
      const dir = path.join(parent, name);
      for (const subdir of ['src', 'test', 'scripts', 'templates']) await mkdir(path.join(dir, subdir), { recursive: true });
      for (const subdir of ['src', 'test', 'scripts', 'templates']) {
        await writeFile(path.join(dir, subdir, 'sample.txt'), `alpha${eol}beta${eol}`);
      }
      for (const file of ['Dockerfile', 'docker-compose.yml', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']) {
        await writeFile(path.join(dir, file), `one${eol}two${eol}`);
      }
      return dir;
    };
    try {
      const lf = await createFixture('lf', '\n');
      const crlf = await createFixture('crlf', '\r\n');
      const buildId = (dir: string) => execFileSync(process.execPath, ['scripts/build-id.mjs', dir], { encoding: 'utf8' }).trim();
      expect(buildId(lf)).toBe(buildId(crlf));
      await writeFile(path.join(crlf, 'src', 'sample.txt'), 'alpha\r\nbeta changed\r\n');
      expect(buildId(lf)).not.toBe(buildId(crlf));
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('keeps nginx forwarding canonical and synchronizes the configured runtime commit helper', async () => {
    const dockerfile = await readFile('Dockerfile', 'utf8');
    expect(dockerfile).toContain('real_ip_header CF-Connecting-IP;');
    expect(dockerfile).toContain('set_real_ip_from 127.0.0.1;');
    expect(dockerfile).toContain('proxy_set_header X-Forwarded-For $remote_addr;');
    expect(dockerfile).not.toContain('$proxy_add_x_forwarded_for');

    const parent = await mkdtemp(path.join(os.tmpdir(), 'helper-sync-'));
    const project = path.join(parent, 'project');
    const shared = path.join(parent, 'shared');
    try {
      await mkdir(path.join(project, 'scripts'), { recursive: true });
      await mkdir(shared, { recursive: true });
      await copyFile('scripts/sync-commit-helper.mjs', path.join(project, 'scripts', 'sync-commit-helper.mjs'));
      await writeFile(path.join(project, 'scripts', 'mcp-kernel-commit.mjs'), 'version one\n');
      await writeFile(path.join(project, '.env'), `SHARED_PATH=${shared}\nMCP_COMMIT_HELPER_TARGET=/shared/bin/mcp-kernel-commit.mjs\n`);
      const syncScript = path.join(project, 'scripts', 'sync-commit-helper.mjs');
      expect(JSON.parse(execFileSync(process.execPath, [syncScript], { encoding: 'utf8' }))).toMatchObject({ enabled: true, matched: true });
      expect(await readFile(path.join(shared, 'bin', 'mcp-kernel-commit.mjs'), 'utf8')).toBe('version one\n');
      await writeFile(path.join(project, 'scripts', 'mcp-kernel-commit.mjs'), 'version two\n');
      const stale = spawnSync(process.execPath, [syncScript, '--check'], { encoding: 'utf8' });
      expect(stale.status).toBe(2);
      expect(JSON.parse(stale.stdout)).toMatchObject({ enabled: true, matched: false });
      execFileSync(process.execPath, [syncScript], { encoding: 'utf8' });
      expect(await readFile(path.join(shared, 'bin', 'mcp-kernel-commit.mjs'), 'utf8')).toBe('version two\n');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('configures independent approval and probe secrets in the Windows setup helper', async () => {
    const setup = await readFile('scripts/setup-keys.ps1', 'utf8');
    expect(setup).toContain("Set-GeneratedSecret 'MCP_OAUTH_APPROVAL_KEY'");
    expect(setup).toContain("Set-GeneratedSecret 'MCP_PROBE_SECRET'");
    expect(setup).toContain('RandomNumberGenerator');
  });

});
