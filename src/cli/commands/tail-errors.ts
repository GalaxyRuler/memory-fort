import { existsSync, watch, type FSWatcher } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { errorsLogPath } from "../../storage/paths.js";

export interface TailOptions {
  /** For tests — return after initial read instead of watching. */
  exitAfterInitial?: boolean;
  /** For tests. */
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface TailResult {
  bytesEmitted: number;
  watcher?: FSWatcher;
}

export async function runTailErrors(opts: TailOptions = {}): Promise<TailResult> {
  const path = errorsLogPath();
  const writeOut = opts.stdout ?? ((text) => process.stdout.write(text));
  const writeErr = opts.stderr ?? ((text) => process.stderr.write(text));

  if (!existsSync(path)) {
    writeErr(`errors.log not found at ${path} — run: memory init\n`);
    return { bytesEmitted: 0 };
  }

  const initial = await readFile(path, "utf-8");
  writeOut(initial);
  let bytesEmitted = Buffer.byteLength(initial, "utf-8");
  let lastSize = (await stat(path)).size;

  if (opts.exitAfterInitial) {
    return { bytesEmitted };
  }

  const watcher = watch(path, async () => {
    try {
      const size = await stat(path);
      if (size.size > lastSize) {
        const fs = await import("node:fs/promises");
        const fd = await fs.open(path, "r");
        try {
          const buf = Buffer.alloc(size.size - lastSize);
          await fd.read(buf, 0, buf.length, lastSize);
          const text = buf.toString("utf-8");
          writeOut(text);
          bytesEmitted += buf.length;
        } finally {
          await fd.close();
        }
      }
      lastSize = size.size;
    } catch {
      // File may be temporarily unavailable during rewrites; next event can catch up.
    }
  });

  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });

  return { bytesEmitted, watcher };
}
