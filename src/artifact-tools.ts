import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

import type { AppConfig } from "./config.js";
import type { ArtifactService } from "./artifact-service.js";
import { runTool, type SuccessResultFormatter } from "./tool-result.js";
import {
  createCachedToolRegistrar,
  TOOL_ANNOTATIONS,
  toolAuthMetadata,
  type CachedToolRegistrar,
} from "./tool-metadata.js";

const formatter: SuccessResultFormatter = {
  contentText: (data) => JSON.stringify(data),
  structuredContent: (data) => data,
  content: (data) => [
    {
      type: "text",
      text: JSON.stringify(data),
    },
    {
      type: "resource_link",
      uri: String(data.downloadUrl),
      name: String(data.name),
      mimeType: "application/octet-stream",
      description: "Short-lived downloadable snapshot of the published file",
    },
  ],
};

export function registerArtifactTools(
  server: McpServer,
  config: AppConfig,
  artifacts: ArtifactService,
  onlyTool?: string,
): void {
  if (onlyTool && onlyTool !== "publish_file") {
    return;
  }

  server.registerTool(
    "publish_file",
    {
      title: "Publish downloadable file",
      description:
        "Snapshot a regular host file and return a short-lived download URL plus an MCP resource link. Use this for finished artifacts that must be transferred out of the remote machine without base64 chunking. The source path is never exposed by the download endpoint.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Absolute path, ~/ path, or a path relative to cwd/default cwd."),
        cwd: z
          .string()
          .optional()
          .describe("Base directory used to resolve a relative path."),
        downloadName: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("Optional file name presented to the downloader. It must not contain path separators or control characters."),
      },
      annotations: TOOL_ANNOTATIONS.additiveNonIdempotentClosed,
      _meta: toolAuthMetadata(config),
    },
    async ({ path, cwd, downloadName }) =>
      runTool(
        async () => {
          const artifact = await artifacts.publish(path, cwd, downloadName);
          return {
            name: artifact.name,
            size: artifact.size,
            sha256: artifact.sha256,
            createdAt: artifact.createdAt,
            expiresAt: artifact.expiresAt,
            downloadUrl: artifact.downloadUrl,
          };
        },
        formatter,
      ),
  );
}

export function createArtifactToolRegistrar(
  config: AppConfig,
  artifacts: ArtifactService,
): CachedToolRegistrar {
  return createCachedToolRegistrar((collector) =>
    registerArtifactTools(collector, config, artifacts),
  );
}
