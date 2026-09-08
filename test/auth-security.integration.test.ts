import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { startHttpServer } from "../src/http-server.js";
import { createServices } from "../src/mcp-server.js";
import { RemoteDevOAuthProvider } from "../src/oauth.js";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

describe("OAuth endpoint security boundaries", () => {
  it("does not trust spoofed forwarded IPs unless a proxy is explicitly configured", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "chatgpt-remote-mcp-auth-boundary-test-"),
    );
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "oauth-approval-key",
        MCP_PUBLIC_URL: baseUrl,
        MCP_OAUTH_STATE_FILE: path.join(temporaryDirectory, "oauth-state.json"),
        MCP_HOST: "127.0.0.1",
        MCP_PORT: String(port),
        MCP_DEFAULT_CWD: temporaryDirectory,
      },
      temporaryDirectory,
    );
    const running = await startHttpServer(config, createServices(config));

    try {
      const approvalKeyAsBearer = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          authorization: "Bearer oauth-approval-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      expect(approvalKeyAsBearer.status).toBe(401);

      const statuses: number[] = [];
      for (let index = 1; index <= 21; index += 1) {
        const response = await fetch(`${baseUrl}/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": `203.0.113.${index}`,
          },
          body: JSON.stringify({
            redirect_uris: ["https://chatgpt.com/connector/oauth/security-test"],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            client_name: `security-test-${index}`,
            scope: "mcp:tools",
          }),
        });
        statuses.push(response.status);
      }

      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(201));
      expect(statuses[20]).toBe(429);
    } finally {
      await running.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });


  it("separates OAuth rate limits by the normalized client IP behind one trusted proxy", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "chatgpt-remote-mcp-proxy-rate-test-"),
    );
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "oauth-approval-key",
        MCP_PUBLIC_URL: baseUrl,
        MCP_OAUTH_STATE_FILE: path.join(temporaryDirectory, "oauth-state.json"),
        MCP_HOST: "127.0.0.1",
        MCP_PORT: String(port),
        MCP_DEFAULT_CWD: temporaryDirectory,
        MCP_TRUST_PROXY_HOPS: "1",
      },
      temporaryDirectory,
    );
    const running = await startHttpServer(config, createServices(config));
    const register = async (clientIp: string, index: number) =>
      fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": clientIp,
        },
        body: JSON.stringify({
          redirect_uris: ["https://chatgpt.com/connector/oauth/proxy-rate-test"],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_name: `proxy-rate-${index}`,
          scope: "mcp:tools",
        }),
      });

    try {
      const distinctStatuses: number[] = [];
      for (let index = 1; index <= 21; index += 1) {
        distinctStatuses.push((await register(`203.0.113.${index}`, index)).status);
      }
      expect(distinctStatuses).toEqual(Array(21).fill(201));

      const sameClientStatuses: number[] = [];
      for (let index = 1; index <= 21; index += 1) {
        sameClientStatuses.push((await register("198.51.100.77", 100 + index)).status);
      }
      expect(sameClientStatuses.slice(0, 20)).toEqual(Array(20).fill(201));
      expect(sameClientStatuses[20]).toBe(429);
    } finally {
      await running.close();
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("rolls back failed state writes and revokes an entire token grant", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "chatgpt-remote-mcp-oauth-store-test-"),
    );
    const baseEnvironment = {
      MCP_OAUTH_ENABLED: "true",
      MCP_OAUTH_APPROVAL_KEY: "oauth-approval-key",
      MCP_PUBLIC_URL: "http://127.0.0.1:34567",
    };
    const metadata = {
      client_id: "security-store-client",
      redirect_uris: ["https://chatgpt.com/connector/oauth/security-store-test"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "security store test",
      scope: "mcp:tools",
    };

    try {
      const blockedDirectory = path.join(temporaryDirectory, "blocked-state-directory");
      await mkdir(blockedDirectory);
      const failedProvider = new RemoteDevOAuthProvider(
        loadConfig(
          {
            ...baseEnvironment,
            MCP_OAUTH_STATE_FILE: path.join(blockedDirectory, "state.json"),
          },
          temporaryDirectory,
        ),
      );
      await expect(
        failedProvider.clientsStore.getClient(metadata.client_id),
      ).resolves.toBeUndefined();
      await rm(blockedDirectory, { recursive: true, force: true });
      await writeFile(blockedDirectory, "block state persistence");
      await expect(
        failedProvider.clientsStore.registerClient(
          metadata as Parameters<typeof failedProvider.clientsStore.registerClient>[0],
        ),
      ).rejects.toThrow();
      await expect(
        failedProvider.clientsStore.getClient(metadata.client_id),
      ).resolves.toBeUndefined();

      const stateFile = path.join(temporaryDirectory, "valid-state.json");
      const provider = new RemoteDevOAuthProvider(
        loadConfig(
          { ...baseEnvironment, MCP_OAUTH_STATE_FILE: stateFile },
          temporaryDirectory,
        ),
      );
      const client = await provider.clientsStore.registerClient(
        metadata as Parameters<typeof provider.clientsStore.registerClient>[0],
      );
      const resource = "http://127.0.0.1:34567/mcp";
      const pair = await provider.clientsStore.issueTokenPair(
        client.client_id,
        ["mcp:tools"],
        resource,
      );
      expect(pair.refresh_token).toBeTypeOf("string");

      await provider.clientsStore.revoke(pair.refresh_token!, client.client_id);

      await expect(
        provider.clientsStore.getAccessToken(pair.access_token),
      ).resolves.toBeUndefined();
      await expect(
        provider.clientsStore.rotateRefreshToken(
          pair.refresh_token!,
          client.client_id,
          resource,
          undefined,
        ),
      ).resolves.toMatchObject({ status: "invalid" });
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
  it("bounds persistent OAuth clients without pruning clients that still have token state", async () => {
    const temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "chatgpt-remote-mcp-client-bound-test-"),
    );
    const stateFile = path.join(temporaryDirectory, "oauth-state.json");
    const config = loadConfig(
      {
        MCP_OAUTH_ENABLED: "true",
        MCP_OAUTH_APPROVAL_KEY: "oauth-approval-key",
        MCP_PUBLIC_URL: "http://127.0.0.1:34567",
        MCP_OAUTH_STATE_FILE: stateFile,
        MCP_OAUTH_MAX_REGISTERED_CLIENTS: "2",
      },
      temporaryDirectory,
    );
    const provider = new RemoteDevOAuthProvider(config);
    const metadata = (id: string, issuedAt: number) => ({
      client_id: id,
      client_id_issued_at: issuedAt,
      redirect_uris: ["https://chatgpt.com/connector/oauth/client-bound-test"],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: id,
      scope: "mcp:tools",
    });
    const resource = "http://127.0.0.1:34567/mcp";

    try {
      await provider.clientsStore.registerClient(metadata("inactive-oldest", 1) as Parameters<typeof provider.clientsStore.registerClient>[0]);
      const active = await provider.clientsStore.registerClient(metadata("active", 2) as Parameters<typeof provider.clientsStore.registerClient>[0]);
      await provider.clientsStore.issueTokenPair(active.client_id, ["mcp:tools"], resource);

      const replacement = await provider.clientsStore.registerClient(metadata("replacement", 3) as Parameters<typeof provider.clientsStore.registerClient>[0]);
      expect(await provider.clientsStore.getClient("inactive-oldest")).toBeUndefined();
      expect(await provider.clientsStore.getClient("active")).toBeDefined();
      expect(await provider.clientsStore.getClient("replacement")).toBeDefined();

      await provider.clientsStore.issueTokenPair(replacement.client_id, ["mcp:tools"], resource);
      await expect(
        provider.clientsStore.registerClient(metadata("overflow", 4) as Parameters<typeof provider.clientsStore.registerClient>[0]),
      ).rejects.toThrow("capacity reached");
      expect(Object.keys(JSON.parse(await readFile(stateFile, "utf8")).clients)).toHaveLength(2);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

});
