import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

import type { AppConfig } from "./config.js";

export type CachedToolRegistrar = (server: McpServer, onlyTool?: string) => void;

interface CachedToolRegistration {
  name: string;
  config: unknown;
  callback: unknown;
}

/** Build reusable schema/config/handler registrations once, then install only the
 * requested registration on each request-local McpServer. */
export function createCachedToolRegistrar(
  build: (collector: McpServer) => void,
): CachedToolRegistrar {
  const registrations: CachedToolRegistration[] = [];
  const collector = {
    registerTool(name: string, config: unknown, callback: unknown) {
      registrations.push({ name, config, callback });
      return {};
    },
  } as unknown as McpServer;
  build(collector);

  return (server, onlyTool) => {
    for (const registration of registrations) {
      if (onlyTool && registration.name !== onlyTool) continue;
      Reflect.apply(server.registerTool, server, [
        registration.name,
        registration.config,
        registration.callback,
      ]);
    }
  };
}

export const OAUTH_SCOPES = ["mcp:tools"] as const;

export const TOOL_ANNOTATIONS = {
  readOnlyClosed: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  additiveIdempotentClosed: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  destructiveIdempotentClosed: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  destructiveNonIdempotentClosed: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  destructiveNonIdempotentOpen: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
} as const satisfies Record<string, ToolAnnotations>;

type ToolSecurityScheme = { type: "oauth2"; scopes: string[] };

/**
 * OpenAI's tool auth extension currently supports only noauth and OAuth 2.0.
 * Static-bearer-only and built-in-auth-disabled deployments intentionally omit
 * securitySchemes instead of inferring an external authentication policy that
 * the process cannot observe. Authentication, if any, remains a connection- or
 * deployment-level concern.
 */
export function toolAuthMetadata(
  config: AppConfig,
): { securitySchemes: ToolSecurityScheme[] } | undefined {
  if (config.oauthEnabled) {
    return {
      securitySchemes: [
        { type: "oauth2", scopes: [...OAUTH_SCOPES] },
      ],
    };
  }
  return undefined;
}
