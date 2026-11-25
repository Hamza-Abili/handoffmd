import { describe, expect, test } from "bun:test";
import { intFlag, parseArgs } from "../src/core/args.ts";

describe("argument parsing", () => {
  test("parses value flags in both forms", () => {
    expect(parseArgs(["prune", "--keep", "2", "--yes"])).toEqual({
      command: "prune",
      positionals: [],
      flags: { keep: "2", yes: true },
    });
    expect(parseArgs(["prune", "--keep=3"]).flags).toEqual({ keep: "3" });
  });

  test("rejects malformed integers", () => {
    expect(() => intFlag({ keep: "2x" }, "keep", 10)).toThrow("non-negative integer");
    expect(() => intFlag({ keep: "1.5" }, "keep", 10)).toThrow("non-negative integer");
    expect(() => intFlag({ keep: "-1" }, "keep", 10)).toThrow("non-negative integer");
    expect(() => intFlag({ keep: "" }, "keep", 10)).toThrow("non-negative integer");
    expect(() => intFlag({ keep: "999999999999999999999" }, "keep", 10)).toThrow(
      "non-negative integer"
    );
  });

  test("accepts non-negative safe integers and falls back", () => {
    expect(intFlag({ keep: "0" }, "keep", 10)).toBe(0);
    expect(intFlag({ keep: "12" }, "keep", 10)).toBe(12);
    expect(intFlag({}, "keep", 10)).toBe(10);
  });
});
