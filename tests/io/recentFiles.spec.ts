import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forgetRecent, getRecentFiles, noteRecent } from "../../src/io/recentFiles";

describe("recent files", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps the newest 50, newest first, each path once", () => {
    for (let i = 0; i < 60; i++) noteRecent(`C:/d/${i}.funda`);
    noteRecent("C:/d/30.funda");
    const list = getRecentFiles();
    expect(list).toHaveLength(50);
    expect(list[0]!.path).toBe("C:/d/30.funda");
    expect(list.filter((r) => r.path === "C:/d/30.funda")).toHaveLength(1);
    expect(list[1]!.path).toBe("C:/d/59.funda");
  });

  it("only forgets a path when asked", () => {
    noteRecent("C:/a.funda");
    noteRecent("C:/b.funda");
    expect(getRecentFiles().map((r) => r.path)).toEqual(["C:/b.funda", "C:/a.funda"]);
    forgetRecent("C:/b.funda");
    expect(getRecentFiles().map((r) => r.path)).toEqual(["C:/a.funda"]);
  });

  it("survives storage that refuses writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => noteRecent("C:/a.funda")).not.toThrow();
    expect(() => forgetRecent("C:/a.funda")).not.toThrow();
  });
});
