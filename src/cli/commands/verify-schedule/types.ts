export type VerifyScheduleAction = "install" | "uninstall" | "status";
export type VerifyScheduleShell = "powershell" | "systemd";

export type ExecFile = (
  command: string,
  args: string[],
  opts?: { cwd?: string; windowsHide?: boolean },
) => Promise<{ stdout?: string; stderr?: string }>;

export interface VerifySchedulePlatformOptions {
  action: VerifyScheduleAction;
  daily?: string;
  memoryRoot: string;
  memoryCommand: string;
  execFile: ExecFile;
}

export interface VerifySchedulePlatformResult {
  action: VerifyScheduleAction;
  platform: NodeJS.Platform | "win32" | "linux" | "darwin";
  scheduler: string;
  taskName: string;
  installed: boolean;
  auditDir: string;
  daily?: string;
  detail?: string;
  scriptPath?: string;
  servicePath?: string;
  timerPath?: string;
  plistPath?: string;
  exitCode: 0 | 1;
}
