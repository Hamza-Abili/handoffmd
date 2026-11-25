import { describe, expect, test } from "bun:test";
import { estimateTokens, truncateToTokens } from "../src/core/tokens.ts";

describe("token budget", () => {
  test("estimates tokens from characters", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("truncates with a marker", () => {
    const input = "paragraph one\n\nparagraph two\n\nparagraph three";
    const output = truncateToTokens(input, 6);
    expect(output.length).toBeLessThan(input.length);
    expect(output).toContain("[truncated");
  });
});
