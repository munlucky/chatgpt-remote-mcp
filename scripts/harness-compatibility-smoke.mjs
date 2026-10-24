import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function classifyHarnessAccessFailure(error) {
  return error?.code === 'ENOENT' ? { status: 'skipped', reason: 'harness_not_installed' }
    : { status: 'blocked', reason: 'harness_inaccessible' };
}

export function isSuccessfulTrackedExit(result) {
  return result.running === false && result.hasMore === false && result.exitCode === 0 && result.signal === null
    && result.timedOut === false && result.executionState === 'exited' && result.persistenceState === 'ok';
}

export async function runHarnessSmoke(options = {}) {
  if (!options.executable) return { status: 'skipped', reason: 'harness_not_configured' };
  const prefix = options.prefix ?? [];
  if (!Array.isArray(prefix) || !prefix.every(v => typeof v === 'string')) throw new Error('Harness prefix must be an array of arguments');
  if (!options.projectsDirectory) return { status: 'blocked', reason: 'isolated_projects_directory_required' };
  if (path.isAbsolute(options.executable)) {
    try { await access(options.executable); } catch (error) { return classifyHarnessAccessFailure(error); }
  }
  await mkdir(options.projectsDirectory, { recursive: true });
  const root = await mkdtemp(path.join(path.resolve(options.projectsDirectory),'mcp-harness-smoke-'));
  const project = path.join(root,'project'), runtime = path.join(root,'kernel-runtime');
  await mkdir(project); await mkdir(runtime);
  let server;
  const checks = [];
  let phase = 'prepare';
  try {
    await writeFile(path.join(project,'package.json'), JSON.stringify({ private: true, type: 'module', scripts: { test: 'node verify.mjs' } }));
    await writeFile(path.join(project,'verify.mjs'), "import{readFileSync}from'node:fs';if(readFileSync('effect.txt','utf8')!=='once\\n'||readFileSync('worker-finished.txt','utf8')!=='finished\\n')process.exit(1);\n");
    const git = spawnSync('git',['init','--quiet',project],{ encoding: 'utf8', windowsHide: true });
    if (git.status !== 0) return { status: 'blocked', reason: 'git_unavailable', phase, checks };
    // No user identity or global Git settings are needed for this disposable project.
    const sessionId = `compatibility-${randomUUID()}`;
    const common = ['--project-root',project,'--runtime-home',runtime,'--provider',options.provider ?? 'codex','--session-id',sessionId,'--json'];
    const { loadConfig } = await import('../dist/src/config.js');
    const { createServices } = await import('../dist/src/mcp-server.js');
    const { startHttpServer } = await import('../dist/src/http-server.js');
    const config = loadConfig({ MCP_AUTH_TOKEN: randomUUID(), MCP_DEFAULT_CWD: project, MCP_EXECUTION_TRACKING: 'required',
      MCP_CONTINUITY_STATE_DIR: path.join(root,'mcp-state'), MCP_USAGE_LOG_DIR: path.join(root,'usage') }, root);
    config.port = 0; config.host = '127.0.0.1';
    const services = createServices(config); server = await startHttpServer(config, services);
    const endpoint = `http://127.0.0.1:${server.httpServer.address().port}/mcp`;
    let requestCounter = 0;
    const rpc = async (name, args, signal) => {
      const response = await fetch(endpoint, { method: 'POST', signal,
        headers: { authorization: `Bearer ${config.authToken}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc:'2.0',id:++requestCounter,method:'tools/call',params:{name,arguments:args} }) });
      const result = await response.json();
      if (result.error || result.result?.isError) throw new Error(`MCP call failed: ${name}`);
      return result.result.structuredContent;
    };
    const task = await rpc('checkpoint_work',{mode:'create',cwd:project,requestId:randomUUID(),objective:'Disposable Harness compatibility',
      checkpoint:{phase:'compatibility',current:'verify',completed:[],remaining:[],blockers:[],changedPaths:[],evidenceRefs:[]}});
    const execute = async (script, operationId = randomUUID(), signal) => {
      let result = await rpc('run_script',{taskId:task.taskId,operationId,runtime:'node',script,workdir:project,yieldTimeMs:3000},signal);
      const duplicate = result.duplicate;
      let stdout = result.stdout ?? '';
      while (result.running || result.hasMore) {
        result = await rpc('read_process',{sessionId:result.sessionId,afterSeq:result.nextSeq,waitMs:30_000,waitMode:'terminal'});
        stdout += result.stdout ?? '';
      }
      return { ...result, stdout, duplicate };
    };
    const cli = async (args, json = true) => {
      const script = `import{spawnSync}from'node:child_process';const r=spawnSync(${JSON.stringify(options.executable)},${JSON.stringify([...prefix,...args])},{encoding:'utf8',windowsHide:true,timeout:60000});process.stdout.write(JSON.stringify({code:r.status,error:r.error?.code??null,stdout:r.stdout??''}));`;
      const process = await execute(script);
      const result = JSON.parse(process.stdout);
      if (result.error === 'ENOENT') return { status:'absent' };
      if (result.code !== 0) return { status:'command_failed', exitCode:result.code };
      return json ? JSON.parse(result.stdout) : { status:'help', text:result.stdout };
    };
    phase = 'public_help';
    const help = await cli(['--help'],false);
    if (help.status === 'absent') return { status:'skipped',reason:'harness_not_installed',checks };
    if (help.status !== 'help' || !help.text.includes('next') || !help.text.includes('report') || !help.text.includes('resume')) return {status:'blocked',reason:'unsupported_public_cli',phase,checks};
    checks.push('public_cli_help');
    phase = 'doctor'; const doctor = await cli(['doctor',...common]);
    if (doctor.status === 'error' || doctor.status === 'command_failed' || doctor.healthy === false) return {status:'blocked',reason:'doctor_not_ready',phase,checks};
    checks.push('doctor');
    const contractFile = path.join(root,'contract.json');
    await writeFile(contractFile,JSON.stringify({objective:'Write a single disposable side effect through MCP and preserve this Run across reconnect',
      acceptance:['effect.txt contains exactly one once line and worker-finished.txt proves the interrupted worker reached its final statement; the test command verifies both'],
      constraints:['Only effect.txt and worker-finished.txt can be changed. Do not commit, push or deploy.'],allowedPaths:['effect.txt','worker-finished.txt']}));
    phase = 'next'; let next = await cli(['next','--contract-json',contractFile,'--invocation-intent','new-task',...common]);
    const runId = next.runId;
    if (!runId || next.action?.type !== 'implement') return {status:'blocked',reason:next.errorCode??'implementation_action_required',phase,checks,action:next.action?.type??null};
    checks.push('initial_contract');
    phase = 'reply_loss';
    const effectScript = "import{appendFileSync,writeFileSync}from'node:fs';appendFileSync('effect.txt','once\\n');await new Promise(r=>setTimeout(r,1200));writeFileSync('worker-finished.txt','finished\\n');";
    const operationId = randomUUID(), controller = new AbortController();
    const pending = execute(effectScript,operationId,controller.signal).catch(error => ({ aborted:error.name === 'AbortError' }));
    const deadline = Date.now()+10_000;
    while (true) {
      try { await access(path.join(project,'effect.txt')); break; }
      catch { if (Date.now()>deadline) throw new Error('side_effect_deadline'); await new Promise(resolve=>setTimeout(resolve,25)); }
    }
    controller.abort(); const lost = await pending;
    if (!lost.aborted) throw new Error('HTTP reply was not interrupted');
    const context = await rpc('get_work_context',{taskId:task.taskId,format:'full'});
    if (context.task?.taskId !== task.taskId) throw new Error('MCP context changed');
    const replay = await execute(effectScript,operationId);
    if (!replay.duplicate || await readFile(path.join(project,'effect.txt'),'utf8') !== 'once\n') throw new Error('duplicate_side_effect');
    if (!isSuccessfulTrackedExit(replay)
      || await readFile(path.join(project,'worker-finished.txt'),'utf8') !== 'finished\n') throw new Error('worker_survival_unconfirmed');
    checks.push('reply_loss_worker_survival','same_operation_one_effect','mcp_context_recovery');
    phase = 'active_run_resume';
    const activeContext = await cli(['context','--run-id',runId,...common]);
    const activeResume = await cli(['resume',runId,...common]);
    const activeContextMatches = activeContext.runId === runId || activeContext.included?.some(entry => entry.id === `stage-${runId}`);
    if (!activeContextMatches || activeResume.runId !== runId || activeResume.status !== 'resumed'
      || activeResume.next?.runId !== runId || activeResume.next?.action?.type !== 'implement'
      || activeResume.next?.stepId !== next.stepId) return {status:'blocked',reason:'active_run_resume_unconfirmed',phase,checks,runId};
    next = activeResume.next;
    checks.push('active_harness_run_resume','active_harness_run_context');
    phase = 'report';
    const obligations = next.action.obligations ?? next.requiredVerifications ?? [];
    const verifications = obligations.filter(o=>o.evidenceClass==='hard').map(o=>{
      const refs = o.allowedCommandRefs ?? [o.commandRef];
      if (!refs.includes('test')) throw new Error('public_test_command_not_allowed');
      return {obligationId:o.obligationId,commandRef:'test',acceptanceCoverage:o.acceptanceIds};
    });
    const reportFile = path.join(root,'report.json');
    await writeFile(reportFile,JSON.stringify({stepId:next.stepId,summary:'effect.txt was written once through a tracked MCP operation; HTTP reply loss, context recovery and exact replay preserved the one effect.',verifications}));
    const report = await cli(['report',runId,'--report-json',reportFile,...common]);
    if (!report.next) return {status:'blocked',reason:report.errorCode??'canonical_report_next_missing',phase,checks,runId};
    next = report.next; checks.push('report_canonical_next');
    if (next.runId !== runId) throw new Error('report_run_changed');
    if (next.action?.type !== 'done') return {status:'blocked',reason:'additional_harness_action',phase,checks,runId,action:next.action?.type??null};
    phase = 'resume';
    const resumed = await cli(['resume',runId,...common]);
    const harnessContext = await cli(['context','--run-id',runId,...common]);
    const contextMatches = harnessContext.runId === runId || harnessContext.included?.some(entry => entry.id === `stage-${runId}`);
    if (resumed.runId !== runId || resumed.status !== 'completed' || resumed.next?.action?.type !== 'done' || !contextMatches) return {status:'blocked',reason:'resume_identity_unconfirmed',phase,checks,runId};
    if (await readFile(path.join(project,'effect.txt'),'utf8') !== 'once\n') throw new Error('side_effect_changed_after_resume');
    checks.push('same_harness_run_resume','same_harness_run_context','harness_done');
    return {status:'passed',runId,checks,sideEffectCount:1,reportNextAction:next.action.type};
  } catch (error) { return {status:'blocked',reason:'smoke_failed',phase,checks,errorKind:['side_effect_deadline','HTTP reply was not interrupted','MCP context changed','duplicate_side_effect','worker_survival_unconfirmed','report_run_changed','side_effect_changed_after_resume','public_test_command_not_allowed'].includes(error?.message)?error.message:typeof error?.code==='string'&&/^[A-Z0-9_]+$/.test(error.code)?error.code:'contract_or_execution_failure'}; }
  finally { if (server) await server.close(); await rm(root,{recursive:true,force:true}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  while (args.length) {
    const key = args.shift(), value = args.shift();
    if (!value || !['--harness-executable','--harness-prefix-json','--projects-dir','--provider'].includes(key)) throw new Error('Invalid smoke option');
    options[key] = value;
  }
  const result = await runHarnessSmoke({executable:options['--harness-executable'],prefix:JSON.parse(options['--harness-prefix-json']??'[]'),projectsDirectory:options['--projects-dir'],provider:options['--provider']});
  console.log(JSON.stringify(result,null,2));
  process.exitCode = result.status === 'blocked' ? 1 : 0;
}
