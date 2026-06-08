export const QUARANTINE_GLOBS = [
  "node_modules/**",
  "dist/**",
  ".git/**",
  ".claude/**",
  ".codex/**",
  "coverage/**",
  ".vitest/**",
  "docs/**",
  "AGENTS.md",
  "src/cli/commands/install-vps.ts",
  "src/cli/commands/install-tailscale-route.ts",
  "src/cli/commands/sync-bootstrap.ts",
  "src/cli/commands/private-ops.ts",
  "test/cli/commands/install-vps.test.ts",
  "test/cli/commands/install-tailscale-route.test.ts",
  "test/cli/commands/sync-bootstrap.test.ts",
  "test/cli/private-ops.test.ts",
  "scripts/release/**",
];

export const PUBLIC_RELEASE_DOC_PATHS = new Set([
  "docs/architecture.md",
  "docs/cli.md",
  "docs/compatibility-matrix.md",
  "docs/public-release-readiness.md",
]);

export const PUBLIC_RELEASE_DOC_DIRS = new Set([
  "docs/release-evidence",
]);

export const PUBLIC_RELEASE_DOC_GLOBS = [
  "docs/release-evidence/*.md",
];

const quarantineMatchers = QUARANTINE_GLOBS.map(globToRegExp);
const publicReleaseDocMatchers = PUBLIC_RELEASE_DOC_GLOBS.map(globToRegExp);

export function isReleaseQuarantined(relPath) {
  const normalized = toPosixPath(relPath);
  if (PUBLIC_RELEASE_DOC_DIRS.has(normalized)) return false;
  if (PUBLIC_RELEASE_DOC_PATHS.has(normalized)) return false;
  if (publicReleaseDocMatchers.some((matcher) => matcher.test(normalized))) return false;
  return quarantineMatchers.some((matcher) => matcher.test(normalized));
}

function globToRegExp(glob) {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += escapeRegExp(char);
    }
  }
  source += "$";
  return new RegExp(source, "i");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosixPath(value) {
  return value.replace(/\\/g, "/");
}
