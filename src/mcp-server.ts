import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { randomUUID } from "node:crypto";

import { createBatchReadRegistrar } from "./batch-read.js";
import type { AppConfig } from "./config.js";
import { ExecutionRecorder } from "./continuity/execution-recorder.js";
import { TaskContinuityService } from "./continuity/task-service.js";
import { TaskStore } from "./continuity/task-store.js";
import { createTaskToolRegistrar } from "./continuity/task-tools.js";
import { WorkspaceIdentityService } from "./continuity/workspace-identity.js";
import { createExecToolRegistrar } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { createFileToolRegistrar } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import type { CachedToolRegistrar } from "./tool-metadata.js";
import { requestMetrics, UsageLog } from "./telemetry.js";

export interface McpServices {
  usageLog: UsageLog;
  processManager: ProcessManager;
  fileService: FileService;
  continuityService: TaskContinuityService;
  executionRecorder: ExecutionRecorder;
  registerTools: CachedToolRegistrar;
}

export function createServices(config: AppConfig): McpServices {
  const usageLog = new UsageLog(config.usageLogDir, config.usageLogMaxBytes, config.usageLogFiles);
  const bootId = randomUUID();
  const processManager = new ProcessManager({
    observeTerminal: (process) => {
      const metrics = requestMetrics.getStore();
      const requestId = metrics?.requestId;
      const toolName = metrics?.toolName;
      if (!requestId || (toolName !== "exec_command" && toolName !== "run_script")) return undefined;
      const trafficClass = metrics?.trafficClass ?? "usage";
      const clientClass = metrics?.clientClass;
      usageLog.record({
        ...process, event: "process_started", timestamp: process.startedAt,
        requestId, toolName, trafficClass, clientClass, bootId, buildId: config.buildId || "unknown",
      });
      return (event) => usageLog.record({
        ...event,
        event: "process_terminal",
        timestamp: event.endedAt,
        requestId,
        toolName,
        trafficClass,
        clientClass,
        bootId,
        buildId: config.buildId || "unknown",
      });
    },
    maxRetainedOutputBytes: config.maxRetainedProcessOutputBytes,
    maxTotalRetainedOutputBytes: config.maxTotalRetainedProcessOutputBytes,
    processRetentionMs: config.processRetentionMs,
    maxProcesses: config.maxProcesses,
    maxRunningProcesses: config.maxRunningProcesses,
    defaultReadOutputBytes: config.defaultProcessOutputBytes,
    maxReadOutputBytes: config.maxOutputBytes,
  });
  const fileService = new FileService({
    defaultCwd: config.defaultCwd,
    maxChunkBytes: config.maxFileChunkBytes,
    maxEditFileBytes: config.maxEditFileBytes,
    maxOutputBytes: config.maxOutputBytes,
  });
  const taskStore = new TaskStore({
    stateDirectory: config.continuityStateDir,
    maxSnapshotBytes: config.continuityMaxSnapshotBytes,
    maxTotalBytes: config.continuityMaxTotalBytes,
  });
  const workspaceIdentity = new WorkspaceIdentityService(
    () => taskStore.installationId,
    config.continuityWorkspaceAliases,
  );
  const executionRecorder = new ExecutionRecorder(taskStore, workspaceIdentity);
  const continuityService = new TaskContinuityService(
    taskStore,
    workspaceIdentity,
    executionRecorder,
    {
      checkpointMaxBytes: config.continuityCheckpointMaxBytes,
      contextMaxBytes: config.continuityContextMaxBytes,
      candidateLimit: 20,
      recentExecutionLimit: 10,
      snapshotLimits: {
        maxFiles: config.continuitySnapshotMaxFiles,
        maxBytes: config.continuitySnapshotMaxBytes,
        maxDurationMs: config.continuitySnapshotMaxDurationMs,
      },
    },
  );

  // Build all reusable Zod schemas, metadata objects and handler closures once.
  // Request-local McpServer instances still receive independent registrations.
  const execTools = createExecToolRegistrar(
    config,
    processManager,
    fileService,
    executionRecorder,
  );
  const fileTools = createFileToolRegistrar(config, fileService);
  const batchRead = createBatchReadRegistrar(config, fileService);
  const taskTools = createTaskToolRegistrar(config, continuityService);
  const registerTools: CachedToolRegistrar = (server, onlyTool) => {
    execTools(server, onlyTool);
    fileTools(server, onlyTool);
    batchRead(server, onlyTool);
    taskTools(server, onlyTool);
  };

  return {
    usageLog,
    processManager,
    fileService,
    continuityService,
    executionRecorder,
    registerTools,
  };
}

export function createMcpServer(
  config: AppConfig,
  services: McpServices,
  onlyTool?: string,
): McpServer {
  // Each stateless HTTP call owns its server/transport. Reuse startup-built tool
  // definitions while installing only the requested tool for direct calls.
  const server = new McpServer(
    {
      name: "chatgpt-remote-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. For long-running work, call get_work_context before deciding what to do, create/update bounded checkpoints with checkpoint_work, and use taskId+operationId together on exec_command/run_script when duplicate execution would be unsafe. Durable receipts record observed execution facts; checkpoints are caller summaries and current workspace state remains authoritative. Never automatically re-run a prepared/running/unknown tracked operation. Use complete_work only after current workspace/evidence review. Untracked process and file tools retain their existing behavior.",
      capabilities: { logging: {} },
    },
  );

  services.registerTools(server, onlyTool);
  return server;
}
