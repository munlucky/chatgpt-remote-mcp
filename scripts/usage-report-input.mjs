// Logs can contain legacy or malformed input. Never echo raw records in reports.
import {constants} from 'node:os';
import errorCodes from '../src/error-codes.json' with { type: 'json' };
const tools=new Set("exec_command run_script write_stdin read_process terminate_process list_processes list_directory stat_path read_file read_files write_file replace_in_file apply_patch upload_file download_file publish_file hash_file make_directory copy_path move_path remove_path chmod_path get_work_context checkpoint_work complete_work request_operator_approval get_operator_approval execute_approved_operation".split(" "));
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)?v:null;
const value=(v,values)=>typeof v==='string'&&values.includes(v)?v:null;
const safeCodes = new Set(errorCodes);
const metricKeys = ['indexHits','indexRebuilds','indexInvalidations','observationMs','observationCleanupMs','taskLookupMs','receiptReadMs','ownerValidationMs','durabilityMs','persistenceMs','gitMs','evidenceMs','receiptReads','syncCalls'];
const token = v => typeof v === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(v) ? v : null;
const time = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT[\d:.+-]+[zZ]?$/.test(v) && Number.isFinite(Date.parse(v)) ? v : null;
export function readEvent(raw) {
  if (!raw || typeof raw !== 'object' || !['mcp_request','process_started','process_terminal'].includes(raw.event)) return null;
  const e = { event: raw.event, timestamp: time(raw.timestamp) };
  if (raw.errorCode != null) e.errorCode = safeCodes.has(raw.errorCode) ? raw.errorCode : 'other';
  if (raw.errorCategory != null) e.errorCategory = ['file_missing','permission_denied','tool_failure'].includes(raw.errorCategory) ? raw.errorCategory : 'other';
  if (raw.continuity && typeof raw.continuity === 'object') e.continuity = Object.fromEntries(metricKeys
    .filter(key => Number.isFinite(raw.continuity[key]) && raw.continuity[key] >= 0)
    .map(key => [key, raw.continuity[key]]));
  for (const key of ['schemaVersion','durationMs','setupMs','toolMs','status','responseBytes','totalOutputBytes','timeoutMs','exitCode']) {
    if (raw[key] === null || Number.isFinite(raw[key])) e[key] = raw[key];
  }
  for (const key of ['requestId','bootId','sessionId']) e[key]=uuid(raw[key]);
  e.buildId=token(raw.buildId);
  e.toolName=typeof raw.toolName==='string'?(tools.has(raw.toolName)?raw.toolName:'other'):null;
  e.rpcMethod=value(raw.rpcMethod,['initialize','notifications/initialized','tools/list','tools/call','ping']);
  e.clientClass=value(raw.clientClass,['codex','openai_mcp','other']);
  e.trafficClass=value(raw.trafficClass,['usage','probe']);e.outcome=value(raw.outcome,['completed','aborted']);
  e.signal=typeof raw.signal==='string'&&Object.hasOwn(constants.signals,raw.signal)?raw.signal:null;
  for (const key of ['toolError','timedOut','spawnFailed']) if (typeof raw[key] === 'boolean') e[key] = raw[key];
  for (const key of ['startedAt','endedAt']) e[key] = time(raw[key]);
  if (raw.correlation && typeof raw.correlation === 'object') {
    e.correlation = {};
    for (const key of ['taskId','operationId','sessionId','executionBootId']) e.correlation[key]=uuid(raw.correlation[key]);
    e.correlation.workspaceId=typeof raw.correlation.workspaceId==='string'&&/^[a-f0-9]{32}$/.test(raw.correlation.workspaceId)?raw.correlation.workspaceId:null;
    e.correlation.unlinkedReason=value(raw.correlation.unlinkedReason,['untracked','not_selected','not_applicable']);
  }
  if (raw.processRead && typeof raw.processRead === 'object') {
    e.processRead = {};
    for (const key of ['running','hasMore','drainOnly','responseDeadlineExceeded']) if (typeof raw.processRead[key] === 'boolean') e.processRead[key] = raw.processRead[key];
    for (const key of ['outputBytes','droppedOutputBytes','requestedAfterSeq','nextSeq']) if (Number.isSafeInteger(raw.processRead[key]) && raw.processRead[key] >= 0) e.processRead[key] = raw.processRead[key];
    for (const key of ['requestedWaitMs','effectiveWaitMs','responseBudgetMs']) if (Number.isInteger(raw.processRead[key]) && raw.processRead[key] >= 0 && raw.processRead[key] <= 305000) e.processRead[key] = raw.processRead[key];
    if (Number.isFinite(raw.processRead.responseElapsedMs) && raw.processRead.responseElapsedMs >= 0) e.processRead.responseElapsedMs = raw.processRead.responseElapsedMs;
    for (const [key,values] of Object.entries({waitMode:['output','terminal'],persistenceVerification:['not_required','verified','pending'],persistenceState:['ok','degraded'],outputAvailability:['unavailable']})) if (values.includes(raw.processRead[key])) e.processRead[key] = raw.processRead[key];
  }
  return e;
}
