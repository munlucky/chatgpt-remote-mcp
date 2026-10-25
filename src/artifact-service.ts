import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, lstat, mkdtemp, rm, stat, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { McpToolError } from "./errors.js";
import { expandPath } from "./paths.js";

export const ARTIFACT_ROUTE = "/artifacts";

export interface ArtifactServiceOptions {
  defaultCwd: string;
  ttlSeconds: number;
  maxBytes: number;
  maxActive: number;
  publicUrl: () => string | undefined;
}

export interface PublishedArtifact {
  token: string;
  name: string;
  size: number;
  sha256: string;
  createdAt: string;
  expiresAt: string;
  downloadUrl: string;
}

export interface ArtifactDownload {
  name: string;
  size: number;
  sha256: string;
  snapshotPath: string;
  expiresAt: string;
}

interface StoredArtifact extends ArtifactDownload {
  token: string;
  expiresAtMs: number;
}

function validDownloadName(value: string): boolean {
  return (
    value.length > 0
    && value.length <= 255
    && value !== "."
    && value !== ".."
    && !/[\\/\0\r\n]/.test(value)
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function normalizePublicUrl(value: string | undefined): string {
  if (!value) {
    throw new McpToolError(
      "artifact_public_url_unavailable",
      "MCP_PUBLIC_URL is required to publish downloadable artifacts",
    );
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpToolError(
      "artifact_public_url_invalid",
      "MCP_PUBLIC_URL must be an absolute URL",
    );
  }

  const isLoopback =
    url.hostname === "localhost"
    || url.hostname === "127.0.0.1"
    || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback)) {
    throw new McpToolError(
      "artifact_public_url_invalid",
      "MCP_PUBLIC_URL must use HTTPS; HTTP is allowed only for loopback tests",
    );
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new McpToolError(
      "artifact_public_url_invalid",
      "MCP_PUBLIC_URL must be an origin-root URL without credentials, query, or fragment",
    );
  }
  return url.origin;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export class ArtifactService {
  readonly #options: ArtifactServiceOptions;
  readonly #artifacts = new Map<string, StoredArtifact>();
  #rootPromise: Promise<string> | undefined;

  constructor(options: ArtifactServiceOptions) {
    this.#options = options;
  }

  async publish(
    sourcePath: string,
    cwd?: string,
    requestedName?: string,
  ): Promise<PublishedArtifact> {
    await this.prune();

    if (this.#artifacts.size >= this.#options.maxActive) {
      throw new McpToolError(
        "artifact_capacity",
        `Published artifact capacity reached (${this.#options.maxActive})`,
      );
    }

    const publicUrl = normalizePublicUrl(this.#options.publicUrl());
    const resolvedCwd = cwd ? expandPath(cwd, this.#options.defaultCwd) : this.#options.defaultCwd;
    const resolvedSource = expandPath(sourcePath, resolvedCwd);
    const sourceInfo = await lstat(resolvedSource);

    if (!sourceInfo.isFile()) {
      throw new McpToolError(
        "artifact_source_not_file",
        "publish_file accepts regular files only; symbolic links and directories are rejected",
      );
    }
    if (sourceInfo.size > this.#options.maxBytes) {
      throw new McpToolError(
        "artifact_too_large",
        `Artifact size ${sourceInfo.size} exceeds the configured limit ${this.#options.maxBytes}`,
      );
    }

    const name = requestedName ?? path.basename(resolvedSource);
    if (!validDownloadName(name)) {
      throw new McpToolError(
        "artifact_name_invalid",
        "downloadName must be a simple file name without path separators or control characters",
      );
    }

    const token = randomBytes(32).toString("base64url");
    const root = await this.#root();
    const snapshotPath = path.join(root, token);

    await copyFile(resolvedSource, snapshotPath);
    const snapshotInfo = await stat(snapshotPath);
    if (!snapshotInfo.isFile()) {
      await unlink(snapshotPath).catch(() => undefined);
      throw new McpToolError("artifact_snapshot_invalid", "Published artifact snapshot is not a regular file");
    }
    if (snapshotInfo.size > this.#options.maxBytes) {
      await unlink(snapshotPath).catch(() => undefined);
      throw new McpToolError(
        "artifact_too_large",
        `Artifact snapshot size ${snapshotInfo.size} exceeds the configured limit ${this.#options.maxBytes}`,
      );
    }

    const sha256 = await sha256File(snapshotPath);
    const now = Date.now();
    const expiresAtMs = now + this.#options.ttlSeconds * 1000;
    const expiresAt = new Date(expiresAtMs).toISOString();
    const downloadUrl = `${publicUrl}${ARTIFACT_ROUTE}/${token}`;

    this.#artifacts.set(token, {
      token,
      name,
      size: snapshotInfo.size,
      sha256,
      snapshotPath,
      expiresAt,
      expiresAtMs,
    });

    return {
      token,
      name,
      size: snapshotInfo.size,
      sha256,
      createdAt: new Date(now).toISOString(),
      expiresAt,
      downloadUrl,
    };
  }

  async resolve(token: string): Promise<ArtifactDownload | undefined> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return undefined;
    }
    await this.prune();
    const artifact = this.#artifacts.get(token);
    if (!artifact) {
      return undefined;
    }
    return {
      name: artifact.name,
      size: artifact.size,
      sha256: artifact.sha256,
      snapshotPath: artifact.snapshotPath,
      expiresAt: artifact.expiresAt,
    };
  }

  async prune(now = Date.now()): Promise<void> {
    const expired: StoredArtifact[] = [];
    for (const artifact of this.#artifacts.values()) {
      if (artifact.expiresAtMs <= now) {
        this.#artifacts.delete(artifact.token);
        expired.push(artifact);
      }
    }
    await Promise.all(expired.map((artifact) => unlink(artifact.snapshotPath).catch(() => undefined)));
  }

  async close(): Promise<void> {
    this.#artifacts.clear();
    const rootPromise = this.#rootPromise;
    this.#rootPromise = undefined;
    if (!rootPromise) {
      return;
    }
    const root = await rootPromise.catch(() => undefined);
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }

  async #root(): Promise<string> {
    this.#rootPromise ??= mkdtemp(path.join(os.tmpdir(), "chatgpt-remote-mcp-artifacts-"));
    return this.#rootPromise;
  }
}
