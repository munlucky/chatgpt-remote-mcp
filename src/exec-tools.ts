import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import * as z from "zod/v4";

import { bindRequest } from "./telemetry-correlation.js";
import { requestMetrics } from "./telemetry.js";
import type { AppConfig } from "./config.js";
import { McpToolError } from "./errors.js";
import type { ExecutionRecorder } from "./continuity/execution-recorder.js";
import type { ExecutionRecord } from "./continuity/task-types.js";
import { FileService } from "./file-service.js";
import {
  assertHostExecutorAvailable,
  createHostExecutorJob,
  mapContainerPathToHost,
} from "./host-executor.js";
import { ProcessManager } from "./process-manager.js";
import { runScript } from "./script-runner.js";
import { runTool, type SuccessResultFormatter } from "./tool-result.js";
import {
  createCachedToolRegistrar,
  TOOL_ANNOTATIONS,
  toolAuthMetadata,
  type CachedToolRegistrar,
} from "./tool-metadata.js";

const DEFAULT_PROCESS_POLL_AFTER_MS = 1000;
const RECOVERY_OUTPUT_BYTES = 16 * 1024;
const PROCESS_RESPONSE_POSTPROCESS_MS = 5_000;
type PersistenceVerification = "not_required" | "verified" | "pending";
interface PollPolicy { waitMode: "output" | "terminal"; waitMs: number; maxOutputBytes: number }
interface ReadResponseBudget { deadline: number; signal?: AbortSignal }

// This limits response waiting. The manager still owns and awaits the one
// terminal write; timing out here never cancels or restarts persistence.
function withinResponseBudget<T>(operation: Promise<T>, budget?: ReadResponseBudget): Promise<T | undefined> {
  if (!budget) return operation;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: T | undefined, error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      budget.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(undefined, budget.signal?.reason ?? new Error("Response aborted"));
    const expire = () => {
      const remaining = budget.deadline - performance.now();
      if (remaining > 0) timer = setTimeout(expire, Math.ceil(remaining));
      else finish(undefined);
    };
    let timer = setTimeout(expire, Math.max(0, Math.ceil(budget.deadline - performance.now())));
    budget.signal?.addEventListener("abort", abort, { once: true });
    operation.then(value => finish(value), error => finish(undefined, error));
    if (budget.signal?.aborted) abort();
  });
}

function processResult(
  result: Awaited<ReturnType<ProcessManager["read"]>>,
  tracking?: { taskId: string; operationId: string; executionState?: string; persistenceState?: string; persistenceVerification?: PersistenceVerification } | undefined,
  policy?: PollPolicy,
): Record<string, unknown> {
  // The manager's workspace binding is internal. Keep IDs visible to clients,
  // including clients which consume only the text content block.
  const { tracking: _binding, ...process } = result;
  const safeTerminal = !result.running && !result.hasMore && result.exitCode === 0
    && result.signal === null && result.timedOut === false
    && tracking?.executionState === "exited" && tracking.persistenceState === "ok"
    && tracking.persistenceVerification === "verified";
  const nextCall = result.running || result.hasMore || tracking?.persistenceVerification === "pending"
    ? {
        tool: "read_process",
        arguments: {
          sessionId: result.sessionId,
          afterSeq: result.nextSeq,
          waitMode: policy?.waitMode ?? result.waitMode ?? "output",
          waitMs: policy?.waitMs ?? DEFAULT_PROCESS_POLL_AFTER_MS,
          maxOutputBytes: policy?.maxOutputBytes ?? RECOVERY_OUTPUT_BYTES,
          drainOnly: result.hasMore,
          ...(tracking ? {taskId:tracking.taskId,operationId:tracking.operationId} : {}),
        },
      }
    : tracking && !safeTerminal
      ? { tool: "get_work_context", arguments: { taskId: tracking.taskId } }
      : undefined;
  return {
    ...process,
    status: result.running ? "accepted" : "completed",
    completed: !result.running,
    persistenceVerification: tracking?.persistenceVerification ?? "not_required",
    ...(result.running ? { pollAfterMs: DEFAULT_PROCESS_POLL_AFTER_MS } : {}),
    ...(nextCall ? { nextCall } : {}),
    ...(tracking
      ? {
          taskId: tracking.taskId,
          operationId: tracking.operationId,
          executionState: tracking.executionState,
          persistenceState: tracking.persistenceState,
        }
      : {}),
  };
}

function receiptReplayResult(record: ExecutionRecord): Record<string, unknown> {
  const completed = record.state === "exited" || record.state === "spawn_failed";
  return {
    taskId: record.taskId,
    operationId: record.operationId,
    sessionId: record.sessionId,
    executionState: record.state,
    status: completed ? "completed" : record.state === "running" ? "accepted" : "unknown",
    running: record.state === "running",
    completed,
    duplicate: true,
    persistenceVerification: completed ? "verified" : "pending",
    outputAvailability: "unavailable",
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    errorCode: record.errorCode,
    persistenceState: record.persistenceState,
    ...(record.state === "running" ? { pollAfterMs: DEFAULT_PROCESS_POLL_AFTER_MS } : {}),
    nextCall: { tool: "get_work_context", arguments: { taskId: record.taskId } },
  };
}

function requireTrackingPair(
  taskId: string | undefined,
  operationId: string | undefined,
  config: AppConfig,
  cwd: string,
): void {
  if (Boolean(taskId) !== Boolean(operationId)) {
    throw new McpToolError(
      "idempotency_conflict",
      "taskId and operationId must be provided together for tracked execution",
    );
  }
  if (!taskId && config.executionTracking === "required") {
    throw new McpToolError(
      "tracking_required",
      "Execution was not started. Read existing work context, create a checkpoint only if no active task exists, then supply taskId and operationId. Do not reissue an existing project task contract.",
      {
        executionTracking: "required",
        nextCall: { tool: "get_work_context", arguments: { cwd } },
      },
    );
  }
}

async function trackedProcessResult(
  processManager: ProcessManager,
  executionRecorder: ExecutionRecorder,
  result: Awaited<ReturnType<ProcessManager["read"]>>,
  taskId: string,
  operationId: string,
  workspaceId: string,
  budget?: ReadResponseBudget,
  policy?: PollPolicy,
): Promise<Record<string, unknown>> {
  const receipt = await withinResponseBudget((async () => {
    if (!result.running) await processManager.waitForTerminalHooks(result.sessionId);
    const receipt = await executionRecorder.store.readExecution(workspaceId, operationId);
    if (!receipt || receipt.taskId !== taskId || receipt.workspaceId !== workspaceId
      || receipt.operationId !== operationId || receipt.sessionId !== result.sessionId
      || receipt.bootId !== executionRecorder.store.bootId) {
      throw new McpToolError("state_corrupt", "Managed process receipt ownership mismatch");
    }
    return receipt;
  })(), budget);
  bindRequest({ taskId, operationId, workspaceId, sessionId: result.sessionId, executionBootId: receipt?.bootId ?? executionRecorder.store.bootId });
  return processResult(result, {
    taskId,
    operationId,
    executionState: receipt?.state,
    persistenceState: receipt?.persistenceState,
    persistenceVerification: result.running ? "not_required"
      : receipt && (receipt.state === "exited" || receipt.state === "spawn_failed") ? "verified" : "pending",
  }, policy);
}

async function observedProcessResult(
  processManager: ProcessManager,
  executionRecorder: ExecutionRecorder,
  result: Awaited<ReturnType<ProcessManager["read"]>>,
  budget?: ReadResponseBudget,
  policy?: PollPolicy,
): Promise<Record<string, unknown>> {
  const binding = result.tracking;
  return binding
    ? trackedProcessResult(
        processManager, executionRecorder, result,
        binding.taskId, binding.operationId, binding.workspaceId, budget, policy,
      )
    : processResult(result, undefined, policy);
}

const PROCESS_RESULT_FORMATTER: SuccessResultFormatter = {
  contentText(data) {
    const output = typeof data.output === "string" ? data.output : "";
    const summary = JSON.stringify({
      sessionId: data.sessionId,
      taskId: data.taskId,
      operationId: data.operationId,
      executionState: data.executionState,
      persistenceState: data.persistenceState,
      persistenceVerification: data.persistenceVerification,
      outputAvailability: data.outputAvailability,
      duplicate: data.duplicate,
      status: data.status,
      running: data.running,
      completed: data.completed,
      pollAfterMs: data.pollAfterMs,
      exitCode: data.exitCode,
      signal: data.signal,
      timedOut: data.timedOut,
      error: data.error,
      errorCode: data.errorCode,
      nextSeq: data.nextSeq,
      hasMore: data.hasMore,
      totalOutputBytes: data.totalOutputBytes,
      droppedOutputBytes: data.droppedOutputBytes,
      nextCall: data.nextCall,
    });
    return output.length > 0 ? `${summary}\n${output}` : summary;
  },
  structuredContent(data) {
    const { output: _combinedOutput, ...structured } = data;
    return structured;
  },
};

function runProcessTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
) {
  return runTool(operation, PROCESS_RESULT_FORMATTER);
}

export function registerExecTools(
  server: McpServer,
  config: AppConfig,
  processManager: ProcessManager,
  fileService: FileService,
  executionRecorder: ExecutionRecorder,
  onlyTool?: string,
): void {
  const authMetadata = toolAuthMetadata(config);
  const environmentSchema = z
    .record(z.string(), z.string())
    .optional()
    .describe("Environment variables added to or overriding the server process environment.");
  const sessionIdSchema = z
    .string()
    .uuid()
    .describe("Process session ID returned by exec_command or run_script.");
  const taskIdSchema = z
    .string()
    .uuid()
    .optional()
    .describe(`Continuity task ID from checkpoint_work/get_work_context. Provide together with operationId. Tracking policy is ${config.executionTracking}; required mode rejects an untracked execution before spawn.`);
  const operationIdSchema = z
    .string()
    .uuid()
    .optional()
    .describe("Caller-generated logical execution ID. Reuse it only when retrying the exact same tracked execution; provide together with taskId.");
  const afterSeqSchema = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Return only retained output chunks whose sequence number is greater than this value. Use the previous nextSeq value; zero starts with the earliest retained output.",
    );
  const timeoutSchema = z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Milliseconds before marking the process timed out and sending SIGTERM. Zero disables the timeout. A process still running five seconds after SIGTERM is sent SIGKILL.",
    );
  const maxOutputBytesSchema = z
    .number()
    .int()
    .min(16 * 1024)
    .max(config.maxOutputBytes)
    .default(config.defaultProcessOutputBytes)
    .describe("Maximum retained process-output bytes included in this result.");

  if (!onlyTool || onlyTool === "exec_command") server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        `Read get_work_context before project work; use taskId+operationId to prevent duplicate execution. Tracking policy: ${config.executionTracking}. Run an unrestricted shell command in the workmachine by default; executionTarget=host uses the optional native host executor with the host user's OS permissions. A successful start always returns a process session ID. By default the call waits ${config.defaultProcessYieldMs} ms, then returns status=accepted when work is still running; follow nextCall with read_process or write_stdin. Never use a new operationId to retry an uncertain execution.`,
      inputSchema: {
        taskId: taskIdSchema,
        operationId: operationIdSchema,
        cmd: z.string().min(1).describe("Shell command or script to execute."),
        executionTarget: z
          .enum(["local", "host"])
          .default("local")
          .describe("Execution environment. local runs in the Linux workmachine; host uses the optional native host executor."),
        workdir: z
          .string()
          .optional()
          .describe(`Working directory. Relative paths resolve from ${config.defaultCwd}; host execution maps the resolved path through MCP_HOST_EXECUTOR_PATH_MAPPINGS.`),
        shell: z
          .string()
          .optional()
          .describe(`Shell executable. local defaults to ${config.defaultShell}; host defaults to the native agent shell (PowerShell on Windows).`),
        login: z
          .boolean()
          .default(true)
          .describe("For POSIX shells, use login-shell semantics (-lc) instead of -c. PowerShell/cmd host execution ignores this flag."),
        env: environmentSchema,
        stdin: z.string().optional().describe("Initial text written to stdin after spawn."),
        timeoutMs: timeoutSchema,
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(config.defaultProcessYieldMs)
          .describe(
            `How long to wait for the process to exit. Server default: ${config.defaultProcessYieldMs} ms. A running process returns status=accepted; use read_process. Zero returns immediately. Successful durable termination with fully drained output needs no automatic context lookup; process exit is not task completion.`,
          ),
        maxOutputBytes: maxOutputBytesSchema,
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({
      taskId,
      operationId,
      cmd,
      executionTarget,
      workdir,
      shell,
      login,
      env,
      stdin,
      timeoutMs,
      yieldTimeMs,
      maxOutputBytes,
    }) =>
      runProcessTool(async () => {
        const cwd = fileService.resolve(".", workdir);
        const executable = shell || config.defaultShell;
        requireTrackingPair(taskId, operationId, config, cwd);

        // Keep the local semantic input byte-for-byte compatible with existing
        // execution receipts. Host-only fields are added only for host execution.
        // Derived deployment state (agent heartbeat and path mappings) is deliberately
        // excluded: replaying an existing receipt must not depend on current host state.
        const semanticInput = executionTarget === "local"
          ? { cmd, cwd, executable, login, env, stdin, timeoutMs }
          : {
              cmd,
              cwd,
              executionTarget: "host",
              shell: shell || null,
              login,
              env,
              stdin,
              timeoutMs,
            };
        const tracking = taskId && operationId
          ? await executionRecorder.prepare({
              taskId,
              operationId,
              cwd,
              toolKind: "exec_command",
              semanticInput,
            })
          : undefined;
        if (tracking && !tracking.shouldSpawn) {
          if (
            ["running", "exited", "spawn_failed"].includes(tracking.record.state) &&
            tracking.record.sessionId &&
            tracking.record.bootId === executionRecorder.store.bootId
          ) {
            try {
              return { ...await trackedProcessResult(
                processManager,
                executionRecorder,
                await processManager.read(tracking.record.sessionId, { maxOutputBytes }),
                taskId!,
                operationId!,
                tracking.record.workspaceId,
              ), duplicate: true };
            } catch {
              // Durable receipt remains authoritative if the in-memory session was evicted.
            }
          }
          return receiptReplayResult(tracking.record);
        }

        let sessionId: string;
        let hostJobCleanup: (() => Promise<void>) | undefined;
        try {
          let hostCwd: string | undefined;
          if (executionTarget === "host") {
            await assertHostExecutorAvailable(config.hostExecutor, config.buildId);
            hostCwd = mapContainerPathToHost(cwd, config.hostExecutor.pathMappings);
          }
          const execution = executionTarget === "host"
            ? await createHostExecutorJob(config.hostExecutor, {
                command: cmd,
                cwd: hostCwd!,
                shell,
                login,
                env,
              })
            : undefined;
          hostJobCleanup = execution?.cleanup;
          sessionId = processManager.start({
            executable: execution ? process.execPath : executable,
            args: execution
              ? [execution.clientScript, execution.jobDir]
              : [login ? "-lc" : "-c", cmd],
            commandForDisplay: execution ? `[host] ${cmd}` : cmd,
            cwd,
            ...(execution ? {} : { env }),
            timeoutMs,
            stdin,
            ...(execution ? { cleanup: execution.cleanup } : {}),
            ...(tracking
              ? {
                  tracking: { taskId: taskId!, operationId: operationId!, workspaceId: tracking.record.workspaceId },
                  onTerminal: async (event) => {
                    await executionRecorder.markTerminal(tracking.record.workspaceId, operationId!, event);
                  },
                }
              : {}),
          });
          hostJobCleanup = undefined;
        } catch (error) {
          await hostJobCleanup?.();
          if (tracking) await executionRecorder.markSpawnFailed(tracking.record);
          throw error;
        }
        if (tracking) {
          try {
            await executionRecorder.markRunning(tracking.record, sessionId);
          } catch {
            await executionRecorder.markPersistenceDegraded(tracking.record.workspaceId, operationId!);
            throw new McpToolError(
              "persistence_unavailable",
              "Tracked command was spawned but its running receipt could not be persisted; do not retry with a new operationId",
              { taskId, operationId, sessionId },
            );
          }
        }
        await processManager.waitForExit(sessionId, yieldTimeMs);
        const result = await processManager.read(sessionId, {
          maxOutputBytes,
        });
        return tracking
          ? trackedProcessResult(
              processManager,
              executionRecorder,
              result,
              taskId!,
              operationId!,
              tracking.record.workspaceId,
            )
          : processResult(result);
      }),
  );

  if (!onlyTool || onlyTool === "run_script") server.registerTool(
    "run_script",
    {
      title: "Run script",
      description:
        `Read get_work_context before project work; use taskId+operationId to prevent duplicate execution. Tracking policy: ${config.executionTracking}. Write a supplied script to a temporary executable file and run it with Bash, sh, Node.js, Python, or an arbitrary interpreter. Execution has the service's full host permissions. A successful start always returns a process session ID. By default the call waits ${config.defaultProcessYieldMs} ms, then returns status=accepted when work is still running; follow nextCall with read_process. Never use a new operationId to retry an uncertain execution.`,
      inputSchema: {
        taskId: taskIdSchema,
        operationId: operationIdSchema,
        runtime: z
          .enum(["bash", "sh", "node", "python", "custom"])
          .default("bash")
          .describe("Script runtime. Use custom with interpreter for any other runtime."),
        script: z.string().describe("Complete script source."),
        workdir: z
          .string()
          .optional()
          .describe(`Working directory. Relative paths resolve from ${config.defaultCwd}.`),
        args: z.array(z.string()).default([]).describe("Arguments passed after the script path."),
        env: environmentSchema,
        interpreter: z
          .string()
          .optional()
          .describe("Interpreter executable override. Required for runtime=custom."),
        interpreterArgs: z
          .array(z.string())
          .default([])
          .describe("Arguments placed before the temporary script path."),
        stdin: z.string().optional().describe("Initial text written to the script stdin."),
        timeoutMs: timeoutSchema,
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(config.defaultProcessYieldMs)
          .describe(
            `How long to wait for the script to exit. Server default: ${config.defaultProcessYieldMs} ms. A running process returns status=accepted; use read_process. Zero returns immediately. Successful durable termination with fully drained output needs no automatic context lookup; process exit is not task completion.`,
          ),
        maxOutputBytes: maxOutputBytesSchema,
        keepScript: z
          .boolean()
          .default(false)
          .describe(
            "Keep the temporary script after process exit and include its path in the result. When false, the temporary directory is removed after exit.",
          ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({
      taskId,
      operationId,
      runtime,
      script,
      workdir,
      args,
      env,
      interpreter,
      interpreterArgs,
      stdin,
      timeoutMs,
      yieldTimeMs,
      maxOutputBytes,
      keepScript,
    }) =>
      runProcessTool(async () => {
        const cwd = fileService.resolve(".", workdir);
        requireTrackingPair(taskId, operationId, config, cwd);
        const tracking = taskId && operationId
          ? await executionRecorder.prepare({
              taskId,
              operationId,
              cwd,
              toolKind: "run_script",
              semanticInput: {
                runtime,
                script,
                cwd,
                args,
                env,
                interpreter,
                interpreterArgs,
                stdin,
                timeoutMs,
                keepScript,
              },
            })
          : undefined;
        if (tracking && !tracking.shouldSpawn) {
          if (
            ["running", "exited", "spawn_failed"].includes(tracking.record.state) &&
            tracking.record.sessionId &&
            tracking.record.bootId === executionRecorder.store.bootId
          ) {
            try {
              return { ...await trackedProcessResult(
                processManager,
                executionRecorder,
                await processManager.read(tracking.record.sessionId, { maxOutputBytes }),
                taskId!,
                operationId!,
                tracking.record.workspaceId,
              ), duplicate: true };
            } catch {
              // Durable receipt remains authoritative if the in-memory session was evicted.
            }
          }
          return receiptReplayResult(tracking.record);
        }

        let spawnedSessionId: string | undefined;
        try {
          const result = await runScript(processManager, {
            runtime,
            script,
            cwd,
            args,
            env,
            interpreter,
            interpreterArgs,
            stdin,
            timeoutMs,
            yieldTimeMs,
            maxOutputBytes,
            keepScript,
            ...(tracking
              ? {
                  tracking: { taskId: taskId!, operationId: operationId!, workspaceId: tracking.record.workspaceId },
                  onStarted: async (sessionId) => {
                    spawnedSessionId = sessionId;
                    try {
                      await executionRecorder.markRunning(tracking.record, sessionId);
                    } catch {
                      await executionRecorder.markPersistenceDegraded(tracking.record.workspaceId, operationId!);
                      throw new McpToolError(
                        "persistence_unavailable",
                        "Tracked script was spawned but its running receipt could not be persisted; do not retry with a new operationId",
                        { taskId, operationId, sessionId },
                      );
                    }
                  },
                  onTerminal: async (event) => {
                    await executionRecorder.markTerminal(tracking.record.workspaceId, operationId!, event);
                  },
                }
              : {}),
          });
          return tracking
            ? trackedProcessResult(
                processManager,
                executionRecorder,
                result,
                taskId!,
                operationId!,
                tracking.record.workspaceId,
              )
            : processResult(result);
        } catch (error) {
          if (tracking && !spawnedSessionId) {
            await executionRecorder.markSpawnFailed(tracking.record);
          }
          throw error;
        }
      }),
  );

  if (!onlyTool || onlyTool === "write_stdin") server.registerTool(
    "write_stdin",
    {
      title: "Write to process stdin",
      description:
        "Write text to an existing process session, optionally close stdin, then return current process state and retained output with sequence numbers greater than afterSeq.",
      inputSchema: {
        sessionId: sessionIdSchema,
        chars: z
          .string()
          .default("")
          .describe("Text to write to the process stdin. An empty value writes nothing."),
        closeStdin: z
          .boolean()
          .default(false)
          .describe("Close the process stdin after writing chars."),
        afterSeq: afterSeqSchema,
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .default(250)
          .describe(
            "When stdin remains open, wait this long for output or process exit. When closeStdin=true, wait this long for process exit before returning.",
          ),
        maxOutputBytes: maxOutputBytesSchema,
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentOpen,
      _meta: authMetadata,
    },
    async ({ sessionId, chars, closeStdin, afterSeq, yieldTimeMs, maxOutputBytes }) =>
      runProcessTool(async () => {
        await processManager.write(sessionId, chars, closeStdin);
        if (closeStdin) {
          await processManager.waitForExit(sessionId, yieldTimeMs);
        }
        const result = await processManager.read(sessionId, {
          afterSeq,
          waitMs: closeStdin ? 0 : yieldTimeMs,
          maxOutputBytes,
        });
        return observedProcessResult(processManager, executionRecorder, result);
      }),
  );

  if (!onlyTool || onlyTool === "read_process") server.registerTool(
    "read_process",
    {
      title: "Read process output",
      description:
        "Read a managed process for output and terminal state. waitMode=output returns on new output or exit; terminal waits for exit or the wait budget. Successful durable termination with drained output has no automatic context lookup. Process exit is not task completion. Read including its task/operation IDs and durable execution state when tracked. Follow nextCall; pass the previous nextSeq as afterSeq to receive only newer output. Process completion is not task completion. Use list_processes for compact status without output.",
      inputSchema: {
        sessionId: sessionIdSchema,
        taskId: taskIdSchema,
        operationId: operationIdSchema,
        afterSeq: afterSeqSchema,
        waitMode: z.enum(["output", "terminal"]).default("output").describe("output wakes on new output or exit; terminal ignores output notifications and waits for exit or waitMs. Both preserve cursors and output limits."),
        drainOnly: z.boolean().default(false).describe("Read retained output immediately for this call. Preserve waitMode/waitMs for subsequent polling."),
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(300_000)
          .default(1000)
          .describe(
            "How long to wait for output newer than afterSeq or for process exit. Zero returns immediately.",
          ),
        maxOutputBytes: maxOutputBytesSchema,
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ sessionId, taskId, operationId, afterSeq, waitMode, waitMs, drainOnly, maxOutputBytes }, extra) => {
      const responseStartedAt = performance.now();
      const effectiveWaitMs = drainOnly ? 0 : Math.min(waitMs, config.processReadWaitMaxMs);
      const deadline = responseStartedAt + effectiveWaitMs + PROCESS_RESPONSE_POSTPROCESS_MS;
      const signals = [extra.signal, requestMetrics.getStore()?.signal].filter((s): s is AbortSignal => Boolean(s));
      const signal = AbortSignal.any(signals);
      const responseMetadata = () => ({waitMode,requestedWaitMs:waitMs,effectiveWaitMs,drainOnly,requestedAfterSeq:afterSeq,
        responseElapsedMs:performance.now()-responseStartedAt,responseBudgetMs:effectiveWaitMs+PROCESS_RESPONSE_POSTPROCESS_MS,
        responseDeadlineExceeded:performance.now()>=deadline});
      return runProcessTool(async () => {
        if (Boolean(taskId) !== Boolean(operationId)) throw new McpToolError("idempotency_conflict", "Provide taskId and operationId together");
        const known = taskId ? processManager.list().find(entry => entry.sessionId === sessionId) : undefined;
        if (known && (!known.tracking || known.tracking.taskId !== taskId || known.tracking.operationId !== operationId)) {
          throw new McpToolError("process_session_unknown", "Session does not match the selected execution. Inspect existing work context; do not restart.");
        }
        let result: Awaited<ReturnType<ProcessManager["read"]>>;
        try {
          result = await processManager.read(sessionId, { afterSeq, waitMs: effectiveWaitMs, waitMode, maxOutputBytes, signal });
        } catch (error) {
          if (!(error instanceof McpToolError) || error.code !== "process_session_unknown" || !taskId || !operationId) throw error;
          // Select the stored owner before binding correlation. UUID syntax is not ownership proof.
          const recovered = await withinResponseBudget((async () => {
            const found = await executionRecorder.store.findTask(taskId);
            const receipt = found ? await executionRecorder.store.readExecution(found.state.workspace.workspaceId, operationId) : null;
            if (!receipt || receipt.taskId !== taskId || receipt.operationId !== operationId
              || receipt.sessionId !== sessionId || receipt.bootId !== executionRecorder.store.bootId) throw error;
            return receipt;
          })(), {deadline,signal});
          if (!recovered) throw new McpToolError("persistence_unavailable", "Receipt recovery could not be verified within the response deadline. Inspect existing work context; do not restart the operation.");
          bindRequest({...recovered,executionBootId:recovered.bootId});
          return {...receiptReplayResult(recovered),duplicate:false,...responseMetadata()};
        }
        if (taskId && (!result.tracking || result.tracking.taskId !== taskId || result.tracking.operationId !== operationId)) {
          throw new McpToolError("process_session_unknown", "Session does not match the selected execution. Inspect existing work context; do not restart.");
        }
        const observed = await observedProcessResult(processManager, executionRecorder, result, { deadline, signal }, {waitMode,waitMs,maxOutputBytes});
        return { ...observed,...responseMetadata() };
      });
    },
  );

  if (!onlyTool || onlyTool === "terminate_process") server.registerTool(
    "terminate_process",
    {
      title: "Terminate process",
      description:
        "Send a signal to a managed process tree. When graceMs is greater than zero, SIGINT and SIGTERM escalate to SIGKILL if the process is still running after the grace period. The call may return while escalation is still pending.",
      inputSchema: {
        sessionId: sessionIdSchema,
        signal: z
          .enum(["SIGINT", "SIGTERM", "SIGKILL"])
          .default("SIGTERM")
          .describe("Signal sent to the managed process tree."),
        graceMs: z
          .number()
          .int()
          .min(0)
          .max(60_000)
          .default(3000)
          .describe(
            "For SIGINT or SIGTERM, milliseconds before SIGKILL escalation; zero disables escalation. The call waits at most one second before returning.",
          ),
      },
      annotations: TOOL_ANNOTATIONS.destructiveNonIdempotentClosed,
      _meta: authMetadata,
    },
    async ({ sessionId, signal, graceMs }) =>
      runProcessTool(async () =>
        observedProcessResult(processManager, executionRecorder, await processManager.terminate(sessionId, signal, graceMs)),
      ),
  );

  if (!onlyTool || onlyTool === "list_processes") server.registerTool(
    "list_processes",
    {
      title: "List managed processes",
      description: "Read compact process metadata without output or command bodies by default. Filter by taskId or exact cwd to avoid mixing projects. Running sessions sort first, followed by newest starts. Counts cover all matching retained sessions even when the result is limited. availableThroughSeq is the latest available output sequence, not an acknowledgement that output was read; retain your previous nextSeq for read_process.",
      inputSchema: {
        taskId: z.string().uuid().optional().describe("Filter by continuity task ID. Untracked sessions are excluded when this filter is supplied."),
        cwd: z.string().min(1).optional().describe("Filter by exact process working directory; relative paths resolve from the default working directory. Different alias paths are distinct; prefer taskId across aliases."),
        runningOnly: z.boolean().default(false).describe("Return only currently running process sessions."),
        limit: z.number().int().min(1).max(100).default(20).describe("Maximum returned entries. Counts include matching entries omitted by this limit."),
        includeCommand: z.boolean().default(false).describe("Explicitly include command bodies. Leave false for compact, metadata-only status checks."),
      },
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async ({ taskId, cwd, runningOnly, limit, includeCommand }) => runTool(() => {
      const resolvedCwd = cwd ? fileService.resolve(".", cwd) : undefined;
      const entries = processManager.list().filter((entry) =>
        (!taskId || entry.tracking?.taskId === taskId) &&
        (!resolvedCwd || path.resolve(entry.cwd) === resolvedCwd) &&
        (!runningOnly || entry.running),
      ).sort((a, b) => Number(b.running) - Number(a.running) || b.startedAt.localeCompare(a.startedAt));
      return {
        processes: entries.slice(0, limit).map(({ command, tracking, ...entry }) => ({
          ...entry,
          ...(tracking ? { taskId: tracking.taskId, operationId: tracking.operationId } : {}),
          ...(includeCommand ? { command } : {}),
        })),
        counts: { matching: entries.length, running: entries.filter((entry) => entry.running).length, returned: Math.min(entries.length, limit) },
        truncated: entries.length > limit,
      };
    }),
  );
}

export function createExecToolRegistrar(
  config: AppConfig,
  processManager: ProcessManager,
  fileService: FileService,
  executionRecorder: ExecutionRecorder,
): CachedToolRegistrar {
  return createCachedToolRegistrar((collector) =>
    registerExecTools(collector, config, processManager, fileService, executionRecorder),
  );
}
