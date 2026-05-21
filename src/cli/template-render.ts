import { execFileSync } from "node:child_process";
import { formatIsoDate } from "../storage/paths.js";

export interface TemplateVars {
  user_name: string;
  user_email: string;
  github_handle: string;
  install_date: string;
  install_commit: string;
}

/**
 * Substitute {{var}} placeholders in template text with values
 * from the vars map. Unknown placeholders are left intact
 * (visible) so users notice missing values.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (_, name: string) => {
    return name in vars ? vars[name]! : `{{${name}}}`;
  });
}

/**
 * Detect template variables from environment: git config for
 * user.name/email, current date, source-repo HEAD if available.
 * Falls back gracefully when git config or repo state is
 * unavailable.
 */
export function detectTemplateVars(
  opts: {
    sourceRepoDir?: string;
    now?: Date;
  } = {},
): TemplateVars {
  const now = opts.now ?? new Date();
  return {
    user_name: gitConfig("user.name") ?? "unknown",
    user_email: gitConfig("user.email") ?? "unknown@example.com",
    github_handle: gitConfig("github.user") ?? "unknown",
    install_date: formatIsoDate(now),
    install_commit: opts.sourceRepoDir
      ? gitRevParse(opts.sourceRepoDir) ?? "unknown"
      : "unknown",
  };
}

function gitConfig(key: string): string | null {
  try {
    const out = execFileSync("git", ["config", "--global", key], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

function gitRevParse(cwd: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
