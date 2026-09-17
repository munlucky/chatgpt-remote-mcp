import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import { McpToolError } from "./errors.js";
import type { ExecutionRecorder } from "./continuity/execution-recorder.js";
import type { ExecutionRecord } from "./continuity/task-types.js";
import { FileService } from "./file-service.js";
import { ProcessManager } from "./process-manager.js";
import { DEFAULT_PROCESS_YIELD_MS, runScript } from "./script-runner.js";
import { runTool, type SuccessResultFormatter } from "./tool-result.js";
import {
  createCachedToolRegistrar,
  TOOL_ANNOTATIONS,
  toolAuthMetadata,
  type CachedToolRegistrar,
} from "./tool-metadata.js";

const DEFAULT_PROCESS_POLL_AFTER_MS = 1000;

function processResult(
  result: Awaited<ReturnType<ProcessManager["read"]>>,
  tracking?: { taskId: string; operationId: string; executionState?: string } | undefined,
): Record<string, unknown> {
  return {
    ...result,
    status: result.running ? "accepted" : "completed",
    completed: !result.running,
    ...(result.running ? { pollAfterMs: DEFAULT_PROCESS_POLL_AFTER_MS } : {}),
    ...(tracking
      ? {
          taskId: tracking.taskId,
          operationId: tracking.operationId,
          executionState: tracking.executionState ?? (result.running ? "running" : "exited"),
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
    exitCode: record.exitCode,
    signal: record.signal,
    timedOut: record.timedOut,
    errorCode: record.errorCode,
    persistenceState: record.persistenceState,
    ...(record.state === "running" ? { pollAfterMs: DEFAULT_PROCESS_POLL_AFTER_MS } : {}),
  };
}

function requireTrackingPair(taskId: string | undefined, operationId: string | undefined): void {
  if (Boolean(taskId) !== Boolean(operationId)) {
    throw new McpToolError(
      "idempotency_conflict",
      "taskId and operationId must be provided together for tracked execution",
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
): Promise<Record<string, unknown>> {
  if (!result.running) {
    await processManager.waitForTerminalHooks(result.sessionId);
  }
  const receipt = await executionRecorder.store.readExecution(workspaceId, operationId);
  return processResult(result, {
    taskId,
    operationId,
    executionState: receipt?.state ?? (result.running ? "running" : "unknown"),
  });
}

const PROCESS_RESULT_FORMATTER: SuccessResultFormatter = {
  contentText(data) {
    const output = typeof data.output === "string" ? data.output : "";
    const summary = JSON.stringify({
      sessionId: data.sessionId,
      status: data.status,
      running: data.running,
      completed: data.completed,
      pollAfterMs: data.pollAfterMs,
      exitCode: data.exitCode,
      signal: data.signal,
      timedOut: data.timedOut,
      error: data.error,
      nextSeq: data.nextSeq,
      hasMore: data.hasMore,
      totalOutputBytes: data.totalOutputBytes,
      droppedOutputBytes: data.droppedOutputBytes,
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
    .describe("Continuity task ID. Provide together with operationId to durably track this execution; omit both for legacy untracked execution.");
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
        "Run an unrestricted shell command on the host. The command inherits the MCP server's full OS permissions, environment, filesystem, and network access. A successful start always returns a process session ID. By default the call waits only 750 ms, then returns status=accepted when work is still running; continue with read_process or write_stdin.",
      inputSchema: {
        taskId: taskIdSchema,
        operationId: operationIdSchema,
        cmd: z.string().min(1).describe("Shell command or script to execute."),
        workdir: z
          .string()
          .optional()
          .describe(`Working directory. Relative paths resolve from ${config.defaultCwd}.`),
        shell: z
          .string()
          .optional()
          .describe(`Shell executable. Defaults to ${config.defaultShell}.`),
        login: z
          .boolean()
          .default(true)
          .describe("Use login-shell semantics (-lc) instead of -c."),
        env: environmentSchema,
        stdin: z.string().optional().describe("Initial text written to stdin after spawn."),
        timeoutMs: timeoutSchema,
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(30_000)
          .default(DEFAULT_PROCESS_YIELD_MS)
          .describe(
            "How long to wait for the process to exit before returning state. Defaults to 750 ms; if still running, the call returns status=accepted with sessionId and pollAfterMs for read_process. Zero returns immediately.",
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
        requireTrackingPair(taskId, operationId);
        const tracking = taskId && operationId
          ? await executionRecorder.prepare({
              taskId,
              operationId,
              cwd,
              toolKind: "exec_command",
              semanticInput: { cmd, cwd, executable, login, env, stdin, timeoutMs },
            })
          : undefined;
        if (tracking && !tracking.shouldSpawn) {
          if (
            tracking.record.state === "running" &&
            tracking.record.sessionId &&
            tracking.record.bootId === executionRecorder.store.bootId
          ) {
            try {
              return trackedProcessResult(
                processManager,
                executionRecorder,
                await processManager.read(tracking.record.sessionId, { maxOutputBytes }),
                taskId!,
                operationId!,
                tracking.record.workspaceId,
              );
            } catch {
              // Durable receipt remains authoritative if the in-memory session was evicted.
            }
          }
          return receiptReplayResult(tracking.record);
        }

        let sessionId: string;
        try {
          sessionId = processManager.start({
            executable,
            args: [login ? "-lc" : "-c", cmd],
            commandForDisplay: cmd,
            cwd,
            env,
            timeoutMs,
            stdin,
            ...(tracking
              ? {
                  onTerminal: async (event) => {
                    await executionRecorder.markTerminal(tracking.record.workspaceId, operationId!, event);
                  },
                }
              : {}),
          });
        } catch (error) {
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
        "Write a supplied script to a temporary executable file and run it with Bash, sh, Node.js, Python, or an arbitrary interpreter. Execution is unrestricted and has the MCP server's full host permissions. A successful start always returns a process session ID. By default the call waits only 750 ms, then returns status=accepted when work is still running; continue with read_process.",
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
          .default(DEFAULT_PROCESS_YIELD_MS)
          .describe(
            "How long to wait for the script process to exit before returning state. Defaults to 750 ms; if still running, the call returns status=accepted with sessionId and pollAfterMs for read_process. Zero returns immediately.",
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
        requireTrackingPair(taskId, operationId);
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
            tracking.record.state === "running" &&
            tracking.record.sessionId &&
            tracking.record.bootId === executionRecorder.store.bootId
          ) {
            try {
              return trackedProcessResult(
                processManager,
                executionRecorder,
                await processManager.read(tracking.record.sessionId, { maxOutputBytes }),
                taskId!,
                operationId!,
                tracking.record.workspaceId,
              );
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
        return processResult(result);
      }),
  );

  if (!onlyTool || onlyTool === "read_process") server.registerTool(
    "read_process",
    {
      title: "Read process output",
      description:
        "Poll a managed process for output and terminal state. Pass the previous nextSeq as afterSeq to receive only newer output.",
      inputSchema: {
        sessionId: sessionIdSchema,
        afterSeq: afterSeqSchema,
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
    async ({ sessionId, afterSeq, waitMs, maxOutputBytes }) =>
      runProcessTool(async () =>
        processResult(
          await processManager.read(sessionId, {
            afterSeq,
            waitMs,
            maxOutputBytes,
          }),
        ),
      ),
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
        processResult(await processManager.terminate(sessionId, signal, graceMs)),
      ),
  );

  if (!onlyTool || onlyTool === "list_processes") server.registerTool(
    "list_processes",
    {
      title: "List managed processes",
      description: "List running and recently completed process sessions.",
      inputSchema: {},
      annotations: TOOL_ANNOTATIONS.readOnlyClosed,
      _meta: authMetadata,
    },
    async () => runTool(() => ({ processes: processManager.list() })),
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
