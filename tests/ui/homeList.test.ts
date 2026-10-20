import { describe, expect, it } from "vitest";
import { buildEntries, displayName, folderLabel, folderPath } from "../../src/ui/homeList";

describe("displayName", () => {
  it("drops the folder and the extension", () => {
    expect(displayName("D:\\parts\\Bracket & Plate.funda")).toBe("Bracket & Plate");
    expect(displayName("/home/a/gear.v2.fundab")).toBe("gear.v2");
    expect(displayName("noext")).toBe("noext");
    expect(displayName("/home/a/.funda")).toBe(".funda");
  });
});

describe("folderLabel", () => {
  it("keeps the last two folder names", () => {
    expect(folderLabel("D:\\work\\clients\\acme\\bracket.funda")).toBe("clients/acme");
    expect(folderLabel("/home/a/b.funda")).toBe("home/a");
    expect(folderLabel("C:\\b.funda")).toBe("C:");
    expect(folderLabel("b.funda")).toBe("");
  });

  it("keeps the full folder for the tooltip", () => {
    expect(folderPath("D:\\work\\acme\\bracket.funda")).toBe("D:\\work\\acme");
    expect(folderPath("/home/a/b.funda")).toBe("/home/a");
  });
});

describe("buildEntries", () => {
  const recents = [
    { path: "D:\\p\\a.funda", openedAt: 300 },
    { path: "D:\\p\\b.funda", openedAt: 200 },
  ];

  it("keeps the recent order and marks the open document", () => {
    const list = buildEntries(recents, "D:\\p\\b.funda");
    expect(list.map((e) => e.name)).toEqual(["a", "b"]);
    expect(list.map((e) => e.open)).toEqual([false, true]);
    expect(list[0]).toMatchObject({ path: "D:\\p\\a.funda", folder: "D:/p", openedAt: 300, editedAt: null, missing: false });
  });

  it("takes the edit time and the missing flag from the stats", () => {
    const stats = new Map([
      ["D:\\p\\a.funda", { path: "D:\\p\\a.funda", exists: true, mtimeMs: 999, size: 10 }],
      ["D:\\p\\b.funda", { path: "D:\\p\\b.funda", exists: false, mtimeMs: null, size: null }],
    ]);
    const list = buildEntries(recents, null, stats);
    expect(list.map((e) => [e.editedAt, e.missing])).toEqual([[999, false], [null, true]]);
  });
});
