import { afterEach, describe, expect, it } from "vitest";

import { ProcessManager } from "../src/process-manager.js";
import { IndexedProcessOutputBuffer } from "../src/process-output-buffer.js";

function createManager(): ProcessManager {
  return new ProcessManager({
    maxRetainedOutputBytes: 1024 * 1024,
    processRetentionMs: 60_000,
    maxProcesses: 16,
    maxTotalRetainedOutputBytes: 4 * 1024 * 1024,
    maxRunningProcesses: 16,
    defaultReadOutputBytes: 1024 * 1024,
    maxReadOutputBytes: 1024 * 1024,
  });
}

describe("IndexedProcessOutputBuffer", () => {
  it("uses sequence offsets after eviction without rescanning retained history", () => {
    const buffer = new IndexedProcessOutputBuffer();
    buffer.append("stdout", [Buffer.from("A"), Buffer.from("B")]);
    buffer.append("stderr", [Buffer.from("C")]);

    expect(buffer.trimTo(2)).toBe(1);
    expect(buffer.droppedBytes).toBe(1);
    expect(buffer.retainedBytes).toBe(2);

    const selection = buffer.selectAfter(0, 2);
    expect(selection.chunks.map(({ seq, stream, data }) => ({
      seq,
      stream,
      text: data.toString("utf8"),
    }))).toEqual([
      { seq: 2, stream: "stdout", text: "B" },
      { seq: 3, stream: "stderr", text: "C" },
    ]);
    expect(selection).toMatchObject({ nextSeq: 3, hasMore: false, selectedBytes: 2 });
  });

  it("keeps cursors correct across repeated logical-head compaction", () => {
    const buffer = new IndexedProcessOutputBuffer();
    const chunks = Array.from({ length: 5000 }, (_, index) => Buffer.from(String(index % 10)));
    buffer.append("stdout", chunks);

    buffer.trimTo(10);
    const selection = buffer.selectAfter(0, 10);

    expect(buffer.retainedChunkCount).toBe(10);
    expect(selection.chunks).toHaveLength(10);
    expect(selection.chunks[0]?.seq).toBe(4991);
    expect(selection.nextSeq).toBe(5000);
    expect(selection.hasMore).toBe(false);
  });
});

describe("ProcessManager", () => {
  let manager: ProcessManager | undefined;

  afterEach(async () => {
    await manager?.shutdown();
  });

  it("captures stdout, stderr, and exit state", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "printf stdout; printf stderr >&2"],
      commandForDisplay: "test output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const result = await manager.read(sessionId);

    expect(result).toMatchObject({
      running: false,
      exitCode: 0,
      stdout: "stdout",
      stderr: "stderr",
      timedOut: false,
    });
    expect(result.output).toContain("stdout");
    expect(result.output).toContain("stderr");
  });

  it("supports interactive stdin and closes cleanly", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/cat",
      args: [],
      commandForDisplay: "cat",
      cwd: process.cwd(),
    });

    await manager.write(sessionId, "hello\n", true);
    await manager.waitForExit(sessionId, 2000);
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hello\n");
  });

  it("terminates a command when its timeout expires", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "sleep 10"],
      commandForDisplay: "sleep 10",
      cwd: process.cwd(),
      timeoutMs: 50,
    });

    await manager.waitForExit(sessionId, 3000);
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timeout");
  });

  it("handles a rejected initial stdin write without crashing the server", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "true"],
      commandForDisplay: "true",
      cwd: process.cwd(),
      stdin: "x".repeat(1024 * 1024),
    });

    await manager.waitForExit(sessionId, 2000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await manager.read(sessionId);

    expect(result.running).toBe(false);
    expect(result.error).toMatch(/stdin write failed|EPIPE/i);
  });

  it("rejects a follow-up stdin write without emitting an unhandled error", async () => {
    manager = createManager();
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "exec 0<&-; printf ready; sleep 2"],
      commandForDisplay: "closed stdin",
      cwd: process.cwd(),
    });
    expect((await manager.read(sessionId, { waitMs: 1000 })).stdout).toContain("ready");

    await expect(manager.write(sessionId, "x".repeat(1024 * 1024))).rejects.toThrow();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await manager.read(sessionId)).error).toMatch(/stdin write failed|EPIPE/i);
  });

  it("preserves UTF-8 characters across paged process output", async () => {
    manager = createManager();
    const expected = `${"a".repeat(16 * 1024 - 1)}😀B`;
    const encoded = Buffer.from(expected).toString("base64");
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.from(${JSON.stringify(encoded)}, "base64"))`],
      commandForDisplay: "unicode output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const first = await manager.read(sessionId, { maxOutputBytes: 16 * 1024 });
    const second = await manager.read(sessionId, {
      afterSeq: first.nextSeq,
      maxOutputBytes: 16 * 1024,
    });

    expect(first.hasMore).toBe(true);
    expect(first.output + second.output).toBe(expected);
    expect(first.output + second.output).not.toContain("�");
  });

  it("retains only the newest process-output chunks when the per-process budget is exceeded", async () => {
    manager = new ProcessManager({
      maxRetainedOutputBytes: 16 * 1024,
      processRetentionMs: 60_000,
      maxProcesses: 16,
      maxTotalRetainedOutputBytes: 4 * 1024 * 1024,
      maxRunningProcesses: 16,
      defaultReadOutputBytes: 1024 * 1024,
      maxReadOutputBytes: 1024 * 1024,
    });
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('a'.repeat(32 * 1024))"],
      commandForDisplay: "bounded output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const result = await manager.read(sessionId);

    expect(result.output).toHaveLength(16 * 1024);
    expect(result.totalOutputBytes).toBe(32 * 1024);
    expect(result.droppedOutputBytes).toBe(16 * 1024);
    expect(result.nextSeq).toBe(2);
  });

  it("separates the default read page size from the hard read maximum", async () => {
    manager = new ProcessManager({
      maxRetainedOutputBytes: 64 * 1024,
      maxTotalRetainedOutputBytes: 64 * 1024,
      processRetentionMs: 60_000,
      maxProcesses: 16,
      maxRunningProcesses: 16,
      defaultReadOutputBytes: 16 * 1024,
      maxReadOutputBytes: 64 * 1024,
    });
    const sessionId = manager.start({
      executable: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(32 * 1024))"],
      commandForDisplay: "paged output",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    const defaultPage = await manager.read(sessionId);
    const explicitPage = await manager.read(sessionId, { maxOutputBytes: 64 * 1024 });

    expect(defaultPage.output).toHaveLength(16 * 1024);
    expect(defaultPage.hasMore).toBe(true);
    expect(explicitPage.output).toHaveLength(32 * 1024);
    expect(explicitPage.hasMore).toBe(false);
  });

  it("evicts least-recent process output when the global retained budget is exceeded", async () => {
    manager = new ProcessManager({
      maxRetainedOutputBytes: 64 * 1024,
      maxTotalRetainedOutputBytes: 32 * 1024,
      processRetentionMs: 60_000,
      maxProcesses: 16,
      maxRunningProcesses: 16,
      defaultReadOutputBytes: 64 * 1024,
      maxReadOutputBytes: 64 * 1024,
    });
    const sessions: string[] = [];
    for (const label of ["a", "b", "c"]) {
      const sessionId = manager.start({
        executable: process.execPath,
        args: ["-e", `process.stdout.write("${label}".repeat(16 * 1024))`],
        commandForDisplay: `output ${label}`,
        cwd: process.cwd(),
      });
      sessions.push(sessionId);
      await manager.waitForExit(sessionId, 2000);
    }

    const first = await manager.read(sessions[0]!);
    const second = await manager.read(sessions[1]!);
    const third = await manager.read(sessions[2]!);

    expect(first.output).toBe("");
    expect(first.droppedOutputBytes).toBe(16 * 1024);
    expect(second.output).toHaveLength(16 * 1024);
    expect(third.output).toHaveLength(16 * 1024);
    expect(manager.stats()).toMatchObject({
      retainedOutputBytes: 32 * 1024,
      droppedOutputBytes: 16 * 1024,
      managedProcesses: 3,
      runningProcesses: 0,
    });
    expect(manager.stats().retainedOutputBytes).toBeLessThanOrEqual(32 * 1024);
  });

  it("rejects only new process starts when the running-process budget is saturated", async () => {
    manager = new ProcessManager({
      maxRetainedOutputBytes: 64 * 1024,
      maxTotalRetainedOutputBytes: 64 * 1024,
      processRetentionMs: 60_000,
      maxProcesses: 16,
      maxRunningProcesses: 1,
      defaultReadOutputBytes: 64 * 1024,
      maxReadOutputBytes: 64 * 1024,
    });
    const runningSession = manager.start({
      executable: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      commandForDisplay: "long running",
      cwd: process.cwd(),
    });

    expect(() => manager!.start({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      commandForDisplay: "rejected",
      cwd: process.cwd(),
    })).toThrow("Maximum running process count (1) reached");
    expect(manager.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: runningSession, running: true }),
    ]));
    await expect(manager.read(runningSession)).resolves.toMatchObject({ running: true });
    await manager.terminate(runningSession, "SIGTERM", 1000);
    await manager.waitForExit(runningSession, 2000);

    expect(() => manager!.start({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
      commandForDisplay: "accepted",
      cwd: process.cwd(),
    })).not.toThrow();
  });
  it("lists processes without pruning and expires completed sessions independently", async () => {
    manager = new ProcessManager({
      maxRetainedOutputBytes: 1024 * 1024,
      processRetentionMs: 500,
      maxProcesses: 16,
      maxTotalRetainedOutputBytes: 4 * 1024 * 1024,
      maxRunningProcesses: 16,
      defaultReadOutputBytes: 1024 * 1024,
      maxReadOutputBytes: 1024 * 1024,
    });
    const sessionId = manager.start({
      executable: "/bin/bash",
      args: ["-c", "true"],
      commandForDisplay: "true",
      cwd: process.cwd(),
    });

    await manager.waitForExit(sessionId, 2000);
    expect(manager.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId, running: false })]),
    );
    await expect(manager.read(sessionId)).resolves.toMatchObject({ running: false });

    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(manager.read(sessionId)).rejects.toThrow("Unknown process session");
  });
});
