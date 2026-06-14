import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface DesktopShortcutOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  /** Override the path to dist/cli.mjs (for tests). */
  cliPath?: string;
}

export interface DesktopShortcutResult {
  created: boolean;
  path: string;
  reason?: string;
}

function resolveCliPath(override?: string): string {
  if (override) return override;
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "cli.mjs",
  );
}

function resolveIconPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "assets",
    "memory_fort_icon.ico",
  );
}

function resolveIconPng(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "assets",
    "memory_fort_icon.png",
  );
}

export async function createDesktopShortcut(
  opts: DesktopShortcutOptions = {},
): Promise<DesktopShortcutResult> {
  const platform = opts.platform ?? process.platform;
  const home = opts.homeDir ?? homedir();

  if (platform === "win32") return createWindowsShortcut(home, opts.cliPath);
  if (platform === "darwin") return createMacShortcut(home, opts.cliPath);
  return createLinuxShortcut(home, opts.cliPath);
}

async function createWindowsShortcut(
  home: string,
  cliOverride?: string,
): Promise<DesktopShortcutResult> {
  const desktop = join(home, "Desktop");
  const shortcutPath = join(desktop, "Memory Fort.lnk");

  if (!existsSync(desktop)) {
    return { created: false, path: shortcutPath, reason: "Desktop folder not found" };
  }

  const cliPath = resolveCliPath(cliOverride);
  const nodePath = process.execPath;
  const iconPath = resolveIconPath();
  const hasIcon = existsSync(iconPath);

  const ps = [
    `$shell = New-Object -ComObject WScript.Shell`,
    `$lnk = $shell.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')`,
    `$lnk.TargetPath = '${nodePath.replace(/'/g, "''")}'`,
    `$lnk.Arguments = '"${cliPath.replace(/'/g, "''")}" dashboard'`,
    `$lnk.WorkingDirectory = '${home.replace(/'/g, "''")}'`,
    `$lnk.Description = 'Open Memory Fort dashboard'`,
  ];
  if (hasIcon) {
    ps.push(`$lnk.IconLocation = '${iconPath.replace(/'/g, "''")},0'`);
  }
  ps.push(`$lnk.Save()`);

  try {
    execFileSync("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-Command", ps.join("; "),
    ], { stdio: "ignore", timeout: 10_000 });
    return { created: true, path: shortcutPath };
  } catch {
    return { created: false, path: shortcutPath, reason: "PowerShell shortcut creation failed" };
  }
}

async function createMacShortcut(
  home: string,
  cliOverride?: string,
): Promise<DesktopShortcutResult> {
  const desktop = join(home, "Desktop");
  const scriptPath = join(desktop, "Memory Fort.command");

  if (!existsSync(desktop)) {
    return { created: false, path: scriptPath, reason: "Desktop folder not found" };
  }

  const cliPath = resolveCliPath(cliOverride);
  const nodePath = process.execPath;

  const content = [
    "#!/bin/bash",
    `exec "${nodePath}" "${cliPath}" dashboard`,
    "",
  ].join("\n");

  try {
    await writeFile(scriptPath, content, "utf-8");
    await chmod(scriptPath, 0o755);
    return { created: true, path: scriptPath };
  } catch {
    return { created: false, path: scriptPath, reason: "Failed to write .command file" };
  }
}

async function createLinuxShortcut(
  home: string,
  cliOverride?: string,
): Promise<DesktopShortcutResult> {
  const desktop = join(home, "Desktop");
  const desktopFile = join(desktop, "memory-fort.desktop");

  if (!existsSync(desktop)) {
    return { created: false, path: desktopFile, reason: "Desktop folder not found" };
  }

  const cliPath = resolveCliPath(cliOverride);
  const nodePath = process.execPath;
  const iconPng = resolveIconPng();
  const hasIcon = existsSync(iconPng);

  const lines = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Memory Fort",
    "Comment=Open Memory Fort dashboard",
    `Exec="${nodePath}" "${cliPath}" dashboard`,
    "Terminal=false",
    "Categories=Development;",
  ];
  if (hasIcon) {
    lines.push(`Icon=${iconPng}`);
  }
  lines.push("");

  try {
    await writeFile(desktopFile, lines.join("\n"), "utf-8");
    await chmod(desktopFile, 0o755);
    return { created: true, path: desktopFile };
  } catch {
    return { created: false, path: desktopFile, reason: "Failed to write .desktop file" };
  }
}
