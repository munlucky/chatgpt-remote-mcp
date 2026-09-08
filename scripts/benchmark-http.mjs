import { loadConfig } from '../dist/src/config.js';
import { createServices } from '../dist/src/mcp-server.js';
import { startHttpServer } from '../dist/src/http-server.js';
const events = [];
const print = console.log;
console.log = (line) => { try { const event = JSON.parse(line); if (event.event === 'mcp_request') events.push(event); } catch {} };
const config = loadConfig({ MCP_AUTH_TOKEN: 'benchmark-only' });
config.host = '127.0.0.1'; config.port = 0;
const running = await startHttpServer(config, createServices(config));
try {
  const url = `http://127.0.0.1:${running.httpServer.address().port}/mcp`;
  for (let i = 0; i < 120; i++) {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer benchmark-only', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'list_processes', arguments: {} } }) });
    const body = await response.json();
    if (!response.ok || body.error || body.result?.isError) throw new Error('Benchmark request failed');
  }
} finally { await running.close(); console.log = print; }
const measured = events.slice(20);
const percentile = (key, p) => measured.map(e => e[key]).sort((a,b) => a-b)[Math.ceil(measured.length*p)-1];
print(JSON.stringify({ workload: 'authenticated list_processes, empty manager, sequential loopback HTTP', samples: measured.length, warmup:20, durationP50Ms:percentile('durationMs',.5), durationP95Ms:percentile('durationMs',.95), setupP50Ms:percentile('setupMs',.5), setupP95Ms:percentile('setupMs',.95) }));
