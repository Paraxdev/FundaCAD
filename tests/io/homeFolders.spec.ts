import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addFolder, getFolders, removeFolder } from "../../src/io/homeFolders";

describe("Home folders", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("keeps folders in the order they were added, each once", () => {
    expect(addFolder("D:/a")).toBe(true);
    expect(addFolder("D:/b")).toBe(true);
    expect(addFolder("D:/a")).toBe(false);
    expect(getFolders().map((f) => f.path)).toEqual(["D:/a", "D:/b"]);
  });

  it("stops at 50", () => {
    for (let i = 0; i < 50; i++) addFolder(`D:/p${i}`);
    expect(addFolder("D:/one-more")).toBe(false);
    expect(getFolders()).toHaveLength(50);
  });

  it("removes only the folder asked for", () => {
    addFolder("D:/a");
    addFolder("D:/b");
    removeFolder("D:/a");
    expect(getFolders().map((f) => f.path)).toEqual(["D:/b"]);
  });

  it("drops rows it cannot read and duplicates", () => {
    localStorage.setItem(
      "fundacad.home.folders",
      JSON.stringify([
        { path: "D:/a", addedAt: 1 },
        { path: "D:/a", addedAt: 2 },
        { path: 5 },
        null,
        { path: "", addedAt: 1 },
        { path: "D:/b", addedAt: 3 },
      ]),
    );
    expect(getFolders()).toEqual([
      { path: "D:/a", addedAt: 1 },
      { path: "D:/b", addedAt: 3 },
    ]);
    localStorage.setItem("fundacad.home.folders", "{not json");
    expect(getFolders()).toEqual([]);
  });

  it("survives storage that refuses writes", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(addFolder("D:/a")).toBe(false);
    expect(() => removeFolder("D:/a")).not.toThrow();
  });
});
