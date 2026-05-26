import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite } from "../../../storage/atomic-write.js";
import { fail, pass, type VerifyCheckContext, type VerifyCheckResult } from "./types.js";

export async function checkVaultReadWrite(
  ctx: VerifyCheckContext,
): Promise<VerifyCheckResult> {
  const rawRoot = join(ctx.vaultRoot, "raw");
  const probePath = join(rawRoot, `.verify-${ctx.now().getTime()}.tmp`);
  const content = `verify ${ctx.now().toISOString()}\n`;
  try {
    await mkdir(rawRoot, { recursive: true });
    await atomicWrite(probePath, content);
    const readBack = await readFile(probePath, "utf-8");
    await unlink(probePath);
    if (readBack !== content) {
      return fail(
        "vault.read-write",
        "vault read/write content mismatch",
        "run `memory init`",
      );
    }
    return pass("vault.read-write", "vault read/write");
  } catch (error) {
    return fail(
      "vault.read-write",
      "vault read/write",
      "run `memory init`",
      error instanceof Error ? error.message : String(error),
    );
  }
}
