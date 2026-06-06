const SECRET_ASSIGNMENT =
  /\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*=\s*)("[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi;
const SECRET_JSON_FIELD =
  /(["']?[A-Z0-9_-]*(?:API[_-]?KEY|ACCESS[_-]?TOKEN|AUTH[_-]?TOKEN|SECRET|PASSWORD)["']?\s*:\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]]+)/gi;
const SECRET_TOKEN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g;
const GITHUB_TOKEN = /\bgh[posru]_[0-9A-Za-z]{36,}\b/g;
const SLACK_TOKEN = /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

export function redactSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED]")
    .replace(SECRET_JSON_FIELD, redactMatchedJsonFieldValue)
    .replace(SECRET_ASSIGNMENT, redactMatchedAssignmentValue)
    .replace(GOOGLE_API_KEY, "[REDACTED]")
    .replace(GITHUB_TOKEN, "[REDACTED]")
    .replace(SLACK_TOKEN, "[REDACTED]")
    .replace(BEARER_TOKEN, "Bearer [REDACTED]")
    .replace(SECRET_TOKEN, "[REDACTED]");
}

export function containsSecretShape(value: string): boolean {
  return value !== redactSecrets(value);
}

function redactMatchedJsonFieldValue(match: string, prefix: string, secretValue: string): string {
  return secretValue.includes("[REDACTED]") ? match : `${prefix}"[REDACTED]"`;
}

function redactMatchedAssignmentValue(match: string, prefix: string, secretValue: string): string {
  return secretValue.includes("[REDACTED]") ? match : `${prefix}[REDACTED]`;
}
