import { spawn } from "node:child_process";

export interface SshCommand {
  command: string;
  description: string;
  allowNonZeroExit?: boolean;
}

export interface SshRunner {
  run(host: string, cmd: SshCommand): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

export function makeRealSshRunner(): SshRunner {
  return {
    run(host: string, cmd: SshCommand) {
      return new Promise((resolve, reject) => {
        const child = spawn("ssh", [host, cmd.command], { windowsHide: true });
        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout += chunk.toString();
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr += chunk.toString();
        });
        child.on("error", (err) => {
          reject(new Error(`ssh failed to start: ${err.message}`));
        });
        child.on("close", (code) => {
          resolve({ stdout, stderr, exitCode: code ?? -1 });
        });
      });
    },
  };
}
