import { describe, expect, test } from "bun:test";
import { redactSecrets, scanSecrets } from "../src/core/redact.ts";

describe("secret redaction", () => {
  test("redacts provider keys and env assignments", () => {
    const input = [
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      'DB_PASSWORD="correct horse battery staple"',
    ].join("\n");
    const { text, findings } = redactSecrets(input);
    expect(findings.length).toBeGreaterThanOrEqual(5);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).not.toContain("ghp_abcdef");
    expect(text).not.toContain("sk-proj-abcdef");
    expect(text).toContain("[REDACTED:aws_access_key]");
    expect(text).toContain("[REDACTED:github_token]");
    expect(text).not.toContain("correct horse battery staple");
  });

  test("does not flag a git sha or a placeholder", () => {
    const input = [
      "commit 0123456789abcdef0123456789abcdef01234567",
      "API_KEY=your_api_key_here",
      "password=changeme",
    ].join("\n");
    expect(scanSecrets(input)).toHaveLength(0);
  });

  test("redacts every secret on a line in the reported context", () => {
    const line =
      "a: ghp_abcdefghijklmnopqrstuvwxyz0123456789 b: ghp_zyxwvutsrqponmlkjihgfedcba9876543210";
    const findings = scanSecrets(line);
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.context).not.toContain("ghp_");
      expect(finding.context).toContain("[REDACTED:github_token]");
    }
  });

  test("redacts multiple assignments on one line", () => {
    const input = "API_KEY=abc123def456 SECRET_TOKEN=xyz789uvw012";
    const { text, findings } = redactSecrets(input);
    expect(findings.length).toBe(2);
    expect(text).not.toContain("abc123def456");
    expect(text).not.toContain("xyz789uvw012");
    expect(text).toContain("API_KEY=[REDACTED:env_assignment]");
    expect(text).toContain("SECRET_TOKEN=[REDACTED:env_assignment]");
  });

  test("redacts private key blocks", () => {
    const input = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----";
    const { text } = redactSecrets(input);
    expect(text).toBe("[REDACTED:private_key]");
  });
});
