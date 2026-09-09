import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { errorMessage } from "./errors.js";
import { requestMetrics } from "./telemetry.js";

export interface SuccessResultFormatter {
  contentText(data: Record<string, unknown>): string;
  structuredContent(data: Record<string, unknown>): Record<string, unknown>;
}

export function successResult(
  data: Record<string, unknown>,
  formatter?: SuccessResultFormatter,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: formatter ? formatter.contentText(data) : JSON.stringify(data),
      },
    ],
    structuredContent: formatter ? formatter.structuredContent(data) : data,
  };
}

export function errorResult(error: unknown): CallToolResult {
  const data = { error: errorMessage(error) };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
    isError: true,
  };
}

export async function runTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
  formatter?: SuccessResultFormatter,
): Promise<CallToolResult> {
  const metrics = requestMetrics.getStore();
  const started = performance.now();
  try {
    const result = successResult(await operation(), formatter);
    if (metrics) metrics.toolError = false;
    return result;
  } catch (error) {
    if (metrics) metrics.toolError = true;
    return errorResult(error);
  } finally {
    if (metrics) metrics.toolMs = Math.round((performance.now() - started) * 10) / 10;
  }
}
