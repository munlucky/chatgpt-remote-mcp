import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { ArtifactService } from "./artifact-service.js";
import { createArtifactToolRegistrar } from "./artifact-tools.js";
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
import { OperatorApprovalService } from "./operator-approval.js";
import { createApprovalToolRegistrar } from "./operator-approval-tools.js";
import type { CachedToolRegistrar } from "./tool-metadata.js";
import { correlation } from "./telemetry-correlation.js";
import { requestMetrics, UsageLog } from "./telemetry.js";

export interface McpServices {
  operatorApprovalService: OperatorApprovalService;
  usageLog: UsageLog;
  processManager: ProcessManager;
  fileService: FileService;
  artifactService: ArtifactService;
  continuityService: TaskContinuityService;
  executionRecorder: ExecutionRecorder;
  registerTools: CachedToolRegistrar;
}

export function createServices(config: AppConfig): McpServices {
  const usageLog = new UsageLog(config.usageLogDir, config.usageLogMaxBytes, config.usageLogFiles);
  const taskStore = new TaskStore({
    stateDirectory: config.continuityStateDir,
    maxSnapshotBytes: config.continuityMaxSnapshotBytes,
    maxTotalBytes: config.continuityMaxTotalBytes,
  });
  const bootId = taskStore.bootId;
  usageLog.startObservation(bootId, config.buildId || "unknown");
  const processManager = new ProcessManager({
    bootId,
    observeTerminal: (process) => {
      const metrics = requestMetrics.getStore();
      const requestId = metrics?.requestId;
      const toolName = metrics?.toolName;
      if (!requestId || (toolName !== "exec_command" && toolName !== "run_script")) return undefined;
      const trafficClass = metrics?.trafficClass ?? "usage";
      const clientClass = metrics?.clientClass;
      const { tracking, ...metadata } = process;
      const binding = correlation({ ...tracking, executionBootId: bootId, sessionId: process.sessionId, unlinkedReason: tracking ? null : "untracked" });
      usageLog.record({
        ...metadata, schemaVersion: 2, correlation: binding, event: "process_started", timestamp: process.startedAt,
        requestId, toolName, trafficClass, clientClass, bootId, buildId: config.buildId || "unknown",
      });
      return (event) => usageLog.record({
        ...event, schemaVersion: 2, correlation: binding,
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
  const artifactService = new ArtifactService({
    defaultCwd: config.defaultCwd,
    ttlSeconds: config.artifactTtlSeconds,
    maxBytes: config.artifactMaxBytes,
    maxActive: config.artifactMaxActive,
    publicUrl: () => config.publicUrl,
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
  const artifactTools = createArtifactToolRegistrar(config, artifactService);
  const batchRead = createBatchReadRegistrar(config, fileService);
  const taskTools = createTaskToolRegistrar(config, continuityService);
  const operatorApprovalService = new OperatorApprovalService(config, continuityService, processManager);
  if (config.operatorApprovalEnabled) {
    continuityService.additionalCompletionBlocker = taskId => operatorApprovalService.hasUnresolvedExecution(taskId);
    continuityService.additionalExecutionContext = taskId => operatorApprovalService.executionContext(taskId);
  }
  const approvalTools = createApprovalToolRegistrar(config, operatorApprovalService);
  const registerTools: CachedToolRegistrar = (server, onlyTool) => {
    execTools(server, onlyTool);
    fileTools(server, onlyTool);
    artifactTools(server, onlyTool);
    batchRead(server, onlyTool);
    taskTools(server, onlyTool);
    approvalTools(server, onlyTool);
  };

  return {
    operatorApprovalService,
    usageLog,
    processManager,
    fileService,
    artifactService,
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
        `Tracking policy: ${config.executionTracking}. Before project work or recovery, call get_work_context with the exact cwd/taskId. Reuse an active task; create a checkpoint only if none exists. Use taskId+operationId on exec_command/run_script; reuse IDs only for exact retries. Follow nextCall/nextSeq. Never replay prepared/running/unknown executions or reissue an existing project task contract. Successful durable process exit with all output drained needs no automatic context lookup. Use context again for reconnect, failure or uncertainty. Chat chooses checkpoint boundaries; process exit is not task completion. Current workspace state is authoritative. These unrestricted tools use the service's full OS permissions. Checkpoints are caller summaries; receipts are observed facts. Do not bypass user-input/approval waits. complete_work closes only explicitly reviewed work. File mutations and stdin writes are not deduplicated by execution tracking.`
        + (config.operatorApprovalEnabled ? ` Operator approval bridge: request_operator_approval supports eligible Kernel legacy identity adoption only. Show approvalUrl to the human and wait. Never collect the operator key in chat or tool arguments, infer consent from chat text, or invent approval references. After browser approval, use execute_approved_operation; do not pass issued references to exec_command/run_script to bypass consumption. Poll the existing approval/session; unknown requires inspection. This workflow does not isolate root capabilities.` : ""),
      capabilities: { logging: {} },
    },
  );

  services.registerTools(server, onlyTool);
  return server;
}
