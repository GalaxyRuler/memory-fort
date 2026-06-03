const SECRET_ASSIGNMENT =
  /\b[A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD)\s*=\s*\S+/gi;
const SECRET_TOKEN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
const PRIVATE_KEY_BLOCK =
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?^-----END [A-Z ]*PRIVATE KEY-----/gm;

export function redactSecrets(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED]")
    .replace(SECRET_ASSIGNMENT, "[REDACTED]")
    .replace(SECRET_TOKEN, "[REDACTED]");
}

export function containsSecretShape(value: string): boolean {
  return value !== redactSecrets(value);
}
