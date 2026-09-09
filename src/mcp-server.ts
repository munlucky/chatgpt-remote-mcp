import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AppConfig } from "./config.js";
import { createExecToolRegistrar } from "./exec-tools.js";
import { FileService } from "./file-service.js";
import { createFileToolRegistrar } from "./file-tools.js";
import { ProcessManager } from "./process-manager.js";
import type { CachedToolRegistrar } from "./tool-metadata.js";
import { createBatchReadRegistrar } from "./batch-read.js";

export interface McpServices {
  processManager: ProcessManager;
  fileService: FileService;
  registerTools: CachedToolRegistrar;
}

export function createServices(config: AppConfig): McpServices {
  const processManager = new ProcessManager({
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

  // Build all reusable Zod schemas, metadata objects and handler closures once.
  // Request-local McpServer instances still receive independent registrations.
  const execTools = createExecToolRegistrar(config, processManager, fileService);
  const fileTools = createFileToolRegistrar(config, fileService);
  const batchRead = createBatchReadRegistrar(config, fileService);
  const registerTools: CachedToolRegistrar = (server, onlyTool) => {
    execTools(server, onlyTool);
    fileTools(server, onlyTool);
    batchRead(server, onlyTool);
  };

  return { processManager, fileService, registerTools };
}

export function createMcpServer(config: AppConfig, services: McpServices, onlyTool?: string): McpServer {
  // Each stateless HTTP call owns its server/transport. Reuse startup-built tool
  // definitions while installing only the requested tool for direct calls.
  const server = new McpServer(
    {
      name: "chatgpt-remote-mcp",
      version: "0.1.0",
    },
    {
      instructions:
        "This server is an unrestricted remote development environment. Tools operate directly on the host with the MCP service process's full OS permissions. Use exec_command for shell, build, test, package, Git, service, and log workflows; run_script for complete Bash, Node.js, or Python scripts; and the file tools for direct file operations. Poll long-running commands with read_process or write_stdin.",
      capabilities: { logging: {} },
    },
  );

  services.registerTools(server, onlyTool);
  return server;
}
