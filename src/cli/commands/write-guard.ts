import { stdin, stdout as processStdout } from "node:process";
import { createInterface } from "node:readline/promises";

export interface CommandStdout {
  isTTY?: boolean;
  write(chunk: string | Uint8Array): unknown;
}

export type ConfirmPrompt = (question: string) => Promise<boolean>;

export interface WriteGuardOptions {
  command: string;
  planned: string[];
  dryRun?: boolean;
  yes?: boolean;
  stdout?: CommandStdout;
  confirm?: ConfirmPrompt;
}

export interface WriteGuardResult {
  shouldWrite: boolean;
  dryRun: boolean;
  cancelled: boolean;
}

export async function guardWrites(opts: WriteGuardOptions): Promise<WriteGuardResult> {
  const stdout = opts.stdout ?? processStdout;
  const dryRun = opts.dryRun === true;
  const shouldPrompt =
    stdout.isTTY === true && opts.yes !== true && !dryRun && opts.planned.length > 0;

  if (dryRun || shouldPrompt) {
    stdout.write(formatWritePlan(opts.command, opts.planned));
  }

  if (dryRun) {
    return { shouldWrite: false, dryRun: true, cancelled: false };
  }

  if (!shouldPrompt) {
    return { shouldWrite: true, dryRun: false, cancelled: false };
  }

  const confirmed = await (opts.confirm ?? defaultConfirm)("Proceed? [Y/n] ");
  if (!confirmed) stdout.write("Cancelled.\n");
  return { shouldWrite: confirmed, dryRun: false, cancelled: !confirmed };
}

export function formatWritePlan(command: string, planned: string[]): string {
  const lines = planned.length > 0 ? planned : ["(no writes planned)"];
  return [
    `${command} will write:`,
    ...lines.map((line) => `  - ${line}`),
    "",
  ].join("\n");
}

async function defaultConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: processStdout });
  try {
    const answer = (await rl.question(question)).trim().toLowerCase();
    return answer.length === 0 || answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}
