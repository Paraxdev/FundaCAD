import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../../src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FACTORIES = /\bcreate(DragHandle|RotationArc|SlimRing)\(/g;
const DEFINED_IN = ["/features/manipulator.ts", "/features/slimRing.ts"];

describe("handle names", () => {
  it("every handle a tool makes is named for the agent harness", () => {
    const missing: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      if (DEFINED_IN.some((d) => path.endsWith(d))) continue;
      const made = text.match(FACTORIES)?.length ?? 0;
      const named = text.match(/\bnameHandle\(/g)?.length ?? 0;
      if (made > named) missing.push(`${path}: ${made} handles, ${named} named`);
    }
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(missing).toEqual([]);
  });
});
