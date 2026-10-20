import { describe, expect, it } from "vitest";
import { branchLog, branchNames, copyName, liveSummary } from "../../src/ui/homeVersions";
import type { DocSummary } from "../../src/io/library";

const row = (id: string, parent: string | null, branch: string, time: number) => ({ id, parent, branch, message: id, time });
const s: DocSummary = {
  format: "funda",
  versions: [row("a", null, "main", 1), row("b", "a", "main", 2), row("c", "a", "alt", 3), row("d", "b", "main", 4)],
  branches: { main: "d", alt: "c", zed: "a" },
  current: "alt",
};

describe("Home versions", () => {
  it("lists a branch newest first through its parents", () => {
    expect(branchLog(s, "main").map((v) => v.id)).toEqual(["d", "b", "a"]);
    expect(branchLog(s, "alt").map((v) => v.id)).toEqual(["c", "a"]);
    expect(branchLog(s, "none")).toEqual([]);
  });

  it("puts the current branch first", () => {
    expect(branchNames(s)).toEqual(["alt", "main", "zed"]);
  });

  it("names a copy after the file and the version, safe as a file name", () => {
    expect(copyName("D:/p/gear.funda", "Before: fillets?")).toBe("gear (Before fillets)");
    expect(copyName("gear.funda", "  ")).toBe("gear (copy)");
    expect(copyName("gear.funda", "x".repeat(100))).toHaveLength(60);
  });

  it("reads the open document's repo like a file's summary", () => {
    expect(liveSummary(null)).toEqual({ format: "funda", versions: [], branches: {}, current: "main" });
    const live = liveSummary({
      objects: { h: "{}" },
      versions: [{ id: "a", parent: null, branch: "main", message: "m", time: 5, tree: { features: [], rest: "h" } }],
      branches: { main: "a" },
      current: "main",
    });
    expect(live.versions).toEqual([{ id: "a", parent: null, branch: "main", message: "m", time: 5 }]);
  });
});
