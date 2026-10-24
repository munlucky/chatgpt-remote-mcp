// Logs can contain legacy or malformed input. Never echo raw records in reports.
const token = v => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v) ? v : null;
const time = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.+-]+[zZ]?$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
export function readEvent(raw) {
  if (!raw || typeof raw !== 'object' || !['mcp_request','process_started','process_terminal'].includes(raw.event)) return null;
  const e = { event: raw.event, timestamp: time(raw.timestamp) };
  for (const key of ['schemaVersion','durationMs','setupMs','toolMs','status','responseBytes','totalOutputBytes','timeoutMs','exitCode']) {
    if (raw[key] === null || Number.isFinite(raw[key])) e[key] = raw[key];
  }
  for (const key of ['requestId','bootId','sessionId','buildId','clientClass','toolName','rpcMethod','signal','trafficClass','outcome']) e[key] = token(raw[key]);
  for (const key of ['toolError','timedOut','spawnFailed']) if (typeof raw[key] === 'boolean') e[key] = raw[key];
  for (const key of ['startedAt','endedAt']) e[key] = time(raw[key]);
  if (raw.correlation && typeof raw.correlation === 'object') {
    e.correlation = {};
    for (const key of ['taskId','workspaceId','operationId','sessionId','executionBootId','unlinkedReason']) e.correlation[key] = token(raw.correlation[key]);
  }
  if (raw.processRead && typeof raw.processRead === 'object') {
    e.processRead = {};
    for (const key of ['running','hasMore']) if (typeof raw.processRead[key] === 'boolean') e.processRead[key] = raw.processRead[key];
    for (const key of ['outputBytes','droppedOutputBytes']) if (Number.isFinite(raw.processRead[key]) && raw.processRead[key] >= 0) e.processRead[key] = raw.processRead[key];
  }
  return e;
}
