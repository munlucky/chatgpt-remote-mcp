import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { monitorEventLoopDelay, performance as nodePerformance } from "node:perf_hooks";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createOAuthMetadata,
  mcpAuthRouter,
  type AuthRouterOptions,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import express, { type Request, type Response } from "express";

import { createBearerAuth, createHostValidation, tokensEqual } from "./auth.js";
import type { AppConfig } from "./config.js";
import { errorMessage } from "./errors.js";
import { createMcpServer, type McpServices } from "./mcp-server.js";
import { OAUTH_SCOPES, RemoteDevOAuthProvider } from "./oauth.js";
import { requestMetrics, safeRpcName, UsageLog, type RequestMetrics, type UsageEvent } from "./telemetry.js";

interface ActiveRequest {
  server: ReturnType<typeof createMcpServer>;
}

export interface RunningHttpServer {
  httpServer: HttpServer;
  close: () => Promise<void>;
}

function rpcError(response: Response, status: number, message: string): void {
  response.status(status).json({
    jsonrpc: "2.0",
    error: { code: -32000, message },
    id: null,
  });
}

function rpcMethod(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const method = (body as { method?: unknown }).method;
  return typeof method === "string" ? method : undefined;
}

function rpcToolName(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return undefined;
  }
  const name = (params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

export async function startHttpServer(
  config: AppConfig,
  services: McpServices,
): Promise<RunningHttpServer> {
  const app = express();
  if (config.oauthEnabled && (config.oauthAccessTokenTtlSeconds > 3600 || config.oauthRefreshTokenTtlSeconds > 2592000)) {
    console.warn("OAuth migration warning: configured TTL exceeds the recommended 1h access / 30d refresh policy. Update existing .env overrides; changing TTL does not invalidate issued tokens. See docs/security-migration.md.");
  }
  const usageLog = new UsageLog(config.usageLogDir, config.usageLogMaxBytes, config.usageLogFiles);
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const eventLoopStart = nodePerformance.eventLoopUtilization();
  app.disable("x-powered-by");
  if (config.trustProxyHops > 0) {
    app.set("trust proxy", config.trustProxyHops);
  }
  app.use((request, response, next) => {
    if (request.path !== config.endpoint) {
      next();
      return;
    }
    const requestId = randomUUID();
    const startedAt = performance.now();
    const metrics: RequestMetrics = { setupMs: null, toolMs: null, toolError: null };
    let responseBytes = 0;
    const countChunk = (chunk: unknown, encoding?: unknown) => {
      if (typeof chunk === "string") responseBytes += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
      else if (chunk instanceof Uint8Array) responseBytes += chunk.byteLength;
    };
    const originalWrite = response.write;
    const originalEnd = response.end;
    response.write = function (this: Response, ...args: any[]) {
      countChunk(args[0], args[1]);
      return Reflect.apply(originalWrite, this, args);
    } as typeof response.write;
    response.end = function (this: Response, ...args: any[]) {
      countChunk(args[0], args[1]);
      return Reflect.apply(originalEnd, this, args);
    } as typeof response.end;
    let logged = false;
    response.set("X-Request-Id", requestId);
    const logCompletion = (outcome: "completed" | "aborted") => {
      if (logged) {
        return;
      }
      logged = true;
      const event: UsageEvent = {
          event: "mcp_request",
          timestamp: new Date().toISOString(),
          buildId: config.buildId || "unknown",
          trafficClass: response.locals.authenticatedMcp === true && config.probeSecret
            && tokensEqual(request.get("x-mcp-probe-secret") || "", config.probeSecret) ? "probe" : "usage",
          requestId,
          httpMethod: request.method,
          rpcMethod: safeRpcName(rpcMethod(request.body), "method"),
          toolName: safeRpcName(rpcToolName(request.body), "tool"),
          status: response.statusCode,
          outcome,
          durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
          ...metrics,
          responseBytes: outcome === "completed" ? responseBytes : null,
        };
      if (config.usageConsoleLog) console.log(JSON.stringify(event));
      usageLog.record(event);
    };
    response.once("finish", () => logCompletion("completed"));
    response.once("close", () => {
      if (!response.writableEnded) {
        logCompletion("aborted");
      }
    });
    requestMetrics.run(metrics, next);
  });
  app.use(createHostValidation(config));

  const activeRequests = new Set<ActiveRequest>();
  let activeMcpRequests = 0;
  let peakActiveMcpRequests = 0;
  const oauthProvider = config.oauthEnabled ? new RemoteDevOAuthProvider(config) : undefined;
  if (oauthProvider) {
    app.get("/.well-known/oauth-protected-resource", (_request, response) => {
      response.set("Access-Control-Allow-Origin", "*").json({
        resource: oauthProvider.resourceUrl.href,
        authorization_servers: [oauthProvider.issuerUrl.href],
        scopes_supported: [...OAUTH_SCOPES],
        bearer_methods_supported: ["header"],
        resource_name: "chatgpt-remote-mcp",
      });
    });
    const oauthRouterOptions = {
      provider: oauthProvider,
      issuerUrl: oauthProvider.issuerUrl,
      resourceServerUrl: oauthProvider.resourceUrl,
      scopesSupported: [...OAUTH_SCOPES],
      resourceName: "chatgpt-remote-mcp",
    } satisfies AuthRouterOptions;
    const oauthMetadata = {
      ...createOAuthMetadata(oauthRouterOptions),
      revocation_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    };
    const issuerPath = oauthProvider.issuerUrl.pathname.replace(/\/$/, "");
    const oauthMetadataPath = `/.well-known/oauth-authorization-server${issuerPath}`;
    app.use((request, response, next) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        request.path === oauthMetadataPath
      ) {
        response.set("Access-Control-Allow-Origin", "*").json(oauthMetadata);
        return;
      }
      next();
    });
    app.use(mcpAuthRouter(oauthRouterOptions));
  }
  const authenticate = createBearerAuth(config, oauthProvider);
  const parseMcpJson = express.json({ limit: config.maxRequestBody });

  app.get("/health", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/diagnostics", authenticate, (_request, response) => {
    const processStats = services.processManager.stats();
    const memory = process.memoryUsage();
    const eventLoopUtilization = nodePerformance.eventLoopUtilization(eventLoopStart);
    response.set("Cache-Control", "no-store");
    response.json({
      status: "ok",
      service: "chatgpt-remote-mcp",
      version: "0.1.0",
      transportMode: "stateless-json",
      activeMcpSessions: 0,
      activeMcpRequests,
      peakActiveMcpRequests,
      ...processStats,
      memory: {
        rss: memory.rss,
        heapTotal: memory.heapTotal,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      eventLoop: {
        utilization: eventLoopUtilization.utilization,
        delayP50Ms: eventLoopDelay.percentile(50) / 1e6,
        delayP95Ms: eventLoopDelay.percentile(95) / 1e6,
        delayP99Ms: eventLoopDelay.percentile(99) / 1e6,
      },
      unrestrictedHostAccess: true,
      oauthEnabled: config.oauthEnabled,
      buildId: config.buildId || "unknown",
      telemetry: {
        enabled: Boolean(config.usageLogDir),
        consoleLog: config.usageConsoleLog,
        pendingEvents: usageLog.pendingEvents,
        droppedEvents: usageLog.droppedEvents,
        writeFailures: usageLog.writeFailures,
      },
    });
  });

  const postHandler = async (request: Request, response: Response): Promise<void> => {
    response.locals.authenticatedMcp = !config.allowNoAuth || Boolean(config.authToken || oauthProvider);
    const setupStarted = performance.now();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(config, services,
      rpcMethod(request.body) === "tools/call" && safeRpcName(rpcToolName(request.body), "tool") !== "other"
        ? rpcToolName(request.body) : undefined);
    const activeRequest = { server };
    activeRequests.add(activeRequest);
    activeMcpRequests += 1;
    peakActiveMcpRequests = Math.max(peakActiveMcpRequests, activeMcpRequests);
    let closed = false;
    const closeRequest = async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      activeRequests.delete(activeRequest);
      activeMcpRequests = Math.max(0, activeMcpRequests - 1);
      await server.close().catch((error) => {
        console.error("Failed to close MCP request:", errorMessage(error));
      });
    };
    response.once("finish", () => void closeRequest());
    response.once("close", () => void closeRequest());
    try {
      transport.onerror = (error) => {
        console.error("MCP transport error:", errorMessage(error));
      };
      await server.connect(transport);
      const metrics = requestMetrics.getStore();
      if (metrics) metrics.setupMs = Math.round((performance.now() - setupStarted) * 10) / 10;
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      console.error("MCP POST failed:", errorMessage(error));
      if (!response.headersSent) {
        rpcError(response, 500, "Internal MCP server error");
      }
      await closeRequest();
    }
  };

  const methodNotAllowed = (_request: Request, response: Response): void => {
    response.set("Allow", "POST");
    rpcError(response, 405, "Stateless MCP accepts POST requests only");
  };

  app.post(
    config.endpoint,
    authenticate,
    parseMcpJson,
    (request, response) => {
      void postHandler(request, response);
    },
  );
  app.get(config.endpoint, authenticate, methodNotAllowed);
  app.delete(config.endpoint, authenticate, methodNotAllowed);

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: express.NextFunction,
    ) => {
      if (!response.headersSent) {
        rpcError(response, 400, `Invalid request body: ${errorMessage(error)}`);
      }
    },
  );

  const cleanupInterval = setInterval(() => {
    services.processManager.prune();
  }, Math.min(config.processRetentionMs, 60_000));
  cleanupInterval.unref();

  const httpServer = await new Promise<HttpServer>((resolve, reject) => {
    const listeningServer = app.listen(config.port, config.host, () => resolve(listeningServer));
    listeningServer.once("error", reject);
  });

  const close = async (): Promise<void> => {
    clearInterval(cleanupInterval);
    eventLoopDelay.disable();
    const requests = [...activeRequests];
    activeRequests.clear();
    activeMcpRequests = 0;
    await Promise.allSettled(requests.map((request) => request.server.close()));
    await services.processManager.shutdown();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await usageLog.flush();
  };

  return { httpServer, close };
}
