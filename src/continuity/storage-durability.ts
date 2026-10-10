import { open, rm } from "node:fs/promises";
import path from "node:path";

/** Persist directory entries, including deletion order, on supported systems. */
export async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    // Windows does not expose directory fsync through Node. File fsync and
    // rename remain available; power-loss durability is limited on that host.
    if (process.platform === "win32" && ["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP"]
      .includes((error as NodeJS.ErrnoException).code ?? "")) return;
    throw error;
  }
}

export async function removeDurably(file: string): Promise<void> {
  await rm(file, { force: true });
  await syncDirectory(path.dirname(file));
}

/** Matching bytes can come from a rename whose directory sync failed. */
export async function syncFileAndParents(file: string, boundary: string): Promise<void> {
  // Windows FlushFileBuffers requires a writable handle; r+ never truncates.
  const handle = await open(file, "r+");
  try { await handle.sync(); } finally { await handle.close(); }
  const stop = path.resolve(boundary);
  let directory = path.dirname(path.resolve(file));
  for (;;) {
    await syncDirectory(directory);
    if (directory === stop) return;
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error("Durability boundary is not a file ancestor");
    directory = parent;
  }
}
