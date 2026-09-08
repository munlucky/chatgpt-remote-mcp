import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { AppConfig } from "./config.js";
import type { FileService } from "./file-service.js";
import { errorMessage } from "./errors.js";
import { runTool } from "./tool-result.js";
import { TOOL_ANNOTATIONS, toolAuthMetadata } from "./tool-metadata.js";

export async function readFiles(files: FileService, paths: string[], cwd: string | undefined, maxBytes: number) {
  const results: Record<string, unknown>[] = new Array(paths.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= paths.length) return;
      try { results[index] = await files.readFileChunk(paths[index]!, cwd, 0, maxBytes, "utf8"); }
      catch (error) { results[index] = { path: paths[index], error: errorMessage(error) }; }
    }
  }));
  return { files: results, count: results.length };
}

export function registerBatchRead(server: McpServer, config: AppConfig, files: FileService): void {
  server.registerTool("read_files", {
    title: "Read multiple files",
    description: "Read up to 16 UTF-8 file chunks in one round trip, with at most four concurrent reads. Results preserve input order and include per-file errors. Use read_file with nextOffset to continue truncated files.",
    inputSchema: {
      paths: z.array(z.string().min(1)).min(1).max(16).describe("One to sixteen paths in result order, resolved against cwd/default cwd."),
      cwd: z.string().optional().describe("Base directory for relative paths."),
      maxBytesPerFile: z.number().int().min(1).max(Math.min(16 * 1024, config.maxFileChunkBytes)).default(4096).describe("Maximum raw bytes per file, with UTF-8 character boundary preservation; follow nextOffset with read_file."),
    },
    annotations: TOOL_ANNOTATIONS.readOnlyClosed,
    _meta: toolAuthMetadata(config),
  }, async ({ paths, cwd, maxBytesPerFile }) => runTool(() => readFiles(files, paths, cwd, maxBytesPerFile)));
}
