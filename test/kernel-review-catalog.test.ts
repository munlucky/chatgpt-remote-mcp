import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createMcpServer, createServices } from "../src/mcp-server.js";

const helperUrl = new URL("../scripts/kernel-review-catalog.mjs", import.meta.url).href;
const { validateOptionalToolCatalog, catalogFeaturesFromEnv } = await import(helperUrl);

it.each([[false, false, 25], [true, false, 28], [false, true, 27], [true, true, 30]])(
  "validates the real MCP catalog with approvals=%s and review=%s", async (approvals, review, count) => {
    const env = { MCP_AUTH_TOKEN: "test", MCP_OPERATOR_APPROVAL_ENABLED: String(approvals),
      MCP_OPERATOR_APPROVAL_KEY: "test-independent-operator-key-123456789", MCP_PUBLIC_URL: "http://localhost",
      MCP_KERNEL_REVIEW_ENABLED: String(review) };
    const config = loadConfig(env), server = createMcpServer(config, createServices(config));
    const client = new Client({ name: "optional-catalog-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair(); await server.connect(st); await client.connect(ct);
    try {
      const catalog = (await client.listTools()).tools; expect(catalog).toHaveLength(Number(count));
      const features = catalogFeaturesFromEnv(env);
      expect(validateOptionalToolCatalog(catalog, features)).toEqual({ operatorApprovalToolsAdvertised: approvals, kernelReviewToolsAdvertised: review });
      if (review) {
        const altered = catalog.map(tool => tool.name === "start_kernel_review" ? { ...tool, name: "missing-review-tool" } : tool);
        expect(() => validateOptionalToolCatalog(altered, features)).toThrow("advertisement mismatch");
      }
      expect(() => validateOptionalToolCatalog(catalog.slice(1), features)).toThrow("incomplete");
    } finally { await client.close(); await server.close(); }
  },
);
