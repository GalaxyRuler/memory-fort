import { open, rename, mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Atomic overwrite via .tmp + rename. Survives mid-write
 * crashes — the target file is either the old content or the
 * new content, never partial.
 *
 * Creates parent directories as needed.
 */
export async function atomicWrite(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  const tmp = `${absolutePath}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(content, "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, absolutePath);
}

/**
 * Append to a file. Creates the file (and parent dirs) if
 * missing. Append is atomic for typical hook payload sizes
 * (≤ few KB) on Windows + POSIX.
 */
export async function atomicAppend(
  absolutePath: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(absolutePath), { recursive: true });
  await appendFile(absolutePath, content, "utf-8");
}
