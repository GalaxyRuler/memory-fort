import { describe, expect, it } from "vitest";
import { containsSecretShape, redactSecrets } from "../../src/privacy/redaction.js";

describe("redactSecrets", () => {
  it("redacts OAuth bearer tokens while preserving the auth scheme", () => {
    const input =
      "Authorization: Bearer abc.def_ghi-jkl~mno+pqr/stu==";

    const output = redactSecrets(input);

    expect(output).toContain("Bearer [REDACTED]");
    expect(output).not.toContain("abc.def_ghi");
    expect(containsSecretShape(input)).toBe(true);
  });

  it("redacts quoted private key blocks", () => {
    const input = [
      '  "pem": "-----BEGIN PRIVATE KEY-----',
      "fake-test-key-material",
      '-----END PRIVATE KEY-----"',
    ].join("\n");

    const output = redactSecrets(input);

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("BEGIN PRIVATE KEY");
    expect(output).not.toContain("fake-test-key-material");
    expect(containsSecretShape(input)).toBe(true);
  });

  it("redacts AWS access key IDs (AKIA/ASIA)", () => {
    const input = "deploy used AKIAIOSFODNN7EXAMPLE and temp ASIAY34FZKBOKMUTVV7A today";

    const output = redactSecrets(input);

    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(output).not.toContain("ASIAY34FZKBOKMUTVV7A");
    expect(output).toContain("[REDACTED]");
    expect(containsSecretShape(input)).toBe(true);
  });

  it("does not flag already-redacted secret shapes", () => {
    const input = [
      "OPENAI_API_KEY=[REDACTED]",
      "VOYAGE_API_KEY=[REDACTED].",
      "Authorization: Bearer [REDACTED]",
      '"apiKey": "[REDACTED]"',
    ].join("\n");

    expect(redactSecrets(input)).toBe(input);
    expect(containsSecretShape(input)).toBe(false);
  });
});
