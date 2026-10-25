import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactService } from "../src/artifact-service.js";

describe("ArtifactService", () => {
  const roots: string[] = [];
  const services: ArtifactService[] = [];

  async function makeService(options: Partial<ConstructorParameters<typeof ArtifactService>[0]> = {}) {
    const root = await mkdtemp(path.join(os.tmpdir(), "artifact-service-test-"));
    roots.push(root);
    const service = new ArtifactService({
      defaultCwd: root,
      ttlSeconds: 600,
      maxBytes: 1024 * 1024,
      maxActive: 4,
      publicUrl: () => "https://mcp.example.test",
      ...options,
    });
    services.push(service);
    return { root, service };
  }

  afterEach(async () => {
    await Promise.allSettled(services.splice(0).map((service) => service.close()));
    await Promise.allSettled(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("publishes an immutable snapshot instead of serving the source path", async () => {
    const { root, service } = await makeService();
    const source = path.join(root, "report.hwp");
    await writeFile(source, "version-one");

    const published = await service.publish("report.hwp");
    await writeFile(source, "version-two");

    const resolved = await service.resolve(published.token);
    expect(resolved).toBeDefined();
    expect(await readFile(resolved!.snapshotPath, "utf8")).toBe("version-one");
    expect(resolved!.snapshotPath).not.toBe(source);
    expect(published.downloadUrl).not.toContain(encodeURIComponent(source));
    expect(published.downloadUrl).not.toContain(source);
  });

  it("expires the capability and deletes its snapshot", async () => {
    const { root, service } = await makeService({ ttlSeconds: 1 });
    await writeFile(path.join(root, "short-lived.bin"), "payload");

    const published = await service.publish("short-lived.bin");
    const before = await service.resolve(published.token);
    expect(before).toBeDefined();

    await service.prune(Date.parse(published.expiresAt) + 1);
    expect(await service.resolve(published.token)).toBeUndefined();
    await expect(readFile(before!.snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsafe names, symbolic links, oversize files, and capacity overflow", async () => {
    const { root, service } = await makeService({ maxBytes: 4, maxActive: 1 });
    await writeFile(path.join(root, "small.bin"), "1234");

    await expect(service.publish("small.bin", undefined, "../escape.bin")).rejects.toMatchObject({
      code: "artifact_name_invalid",
    });

    await symlink(path.join(root, "small.bin"), path.join(root, "link.bin"));
    await expect(service.publish("link.bin")).rejects.toMatchObject({
      code: "artifact_source_not_file",
    });

    await writeFile(path.join(root, "large.bin"), "12345");
    await expect(service.publish("large.bin")).rejects.toMatchObject({
      code: "artifact_too_large",
    });

    await service.publish("small.bin");
    await expect(service.publish("small.bin")).rejects.toMatchObject({
      code: "artifact_capacity",
    });
  });

  it("requires a safe origin-root public URL only when publishing", async () => {
    const { root, service } = await makeService({ publicUrl: () => undefined });
    await writeFile(path.join(root, "artifact.bin"), "payload");

    await expect(service.publish("artifact.bin")).rejects.toMatchObject({
      code: "artifact_public_url_unavailable",
    });

    for (const publicUrl of [
      "not-a-url",
      "http://mcp.example.test",
      "https://user:password@mcp.example.test",
      "https://mcp.example.test/path",
      "https://mcp.example.test?query=1",
      "https://mcp.example.test#fragment",
    ]) {
      const unsafe = new ArtifactService({
        defaultCwd: root,
        ttlSeconds: 600,
        maxBytes: 1024 * 1024,
        maxActive: 4,
        publicUrl: () => publicUrl,
      });
      services.push(unsafe);
      await expect(unsafe.publish("artifact.bin"), publicUrl).rejects.toMatchObject({
        code: "artifact_public_url_invalid",
      });
    }
  });
});
