import { symlink, lstat, unlink, mkdir, rm, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * Create a symlink (POSIX) or junction (Windows directories) at
 * `linkPath` pointing to `target`. If linkPath already exists
 * and points to the same target, no-op. If it exists but points
 * elsewhere, error unless force=true (then replace).
 */
export async function ensureSymlinkOrJunction(
  target: string,
  linkPath: string,
  opts: { force?: boolean } = {},
): Promise<"created" | "exists" | "replaced"> {
  await mkdir(dirname(linkPath), { recursive: true });

  if (existsSync(linkPath)) {
    const st = await lstat(linkPath);
    if (st.isSymbolicLink()) {
      const current = await readlink(linkPath);
      if (samePath(current, target)) return "exists";
      if (!opts.force) {
        throw new Error(`${linkPath} points elsewhere; refusing to replace without force`);
      }
      await unlink(linkPath);
    } else {
      if (!opts.force) {
        throw new Error(
          `${linkPath} exists and is not a symlink; refusing to replace without force`,
        );
      }
      await rm(linkPath, { recursive: true, force: true });
    }
    await createLink(target, linkPath);
    return "replaced";
  }

  await createLink(target, linkPath);
  return "created";
}

async function createLink(target: string, linkPath: string): Promise<void> {
  const type = process.platform === "win32" ? "junction" : "dir";
  await symlink(target, linkPath, type);
}

function samePath(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase();
}
