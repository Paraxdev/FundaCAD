import { describe, expect, it } from "vitest";
import { buildEntries, displayName, filterEntries, folderEntries, folderLabel, folderName, folderPath, folderSort, sortEntries, type HomeEntry } from "../../src/ui/homeList";

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

const entry = (name: string, folder: string, openedAt: number | null, editedAt: number | null): HomeEntry =>
  ({ path: `${folder}/${name}.funda`, name, folder, openedAt, editedAt, missing: false, open: false });

describe("sortEntries", () => {
  const list = [entry("b", "x", 3, 10), entry("a", "x", 3, 30), entry("c", "x", 1, null), entry("Ä", "x", 2, 20)];
  const names = (mode: "opened" | "edited" | "name") => sortEntries(list, mode).map((e) => e.name);

  it("puts the last opened first, ties by name", () => {
    expect(names("opened")).toEqual(["a", "b", "Ä", "c"]);
  });

  it("puts the last edited first, falling back to the open time", () => {
    expect(names("edited")).toEqual(["a", "Ä", "b", "c"]);
  });

  it("orders by name, accents and case aside", () => {
    expect(names("name")).toEqual(["a", "Ä", "b", "c"]);
  });

  it("leaves the input alone", () => {
    sortEntries(list, "name");
    expect(list.map((e) => e.name)).toEqual(["b", "a", "c", "Ä"]);
  });
});

describe("filterEntries", () => {
  const list = [entry("Bracket", "clients/acme", 1, 1), entry("Gear", "parts/Zürich", 1, 1), entry("Lever", "parts/misc", 1, 1)];
  const names = (q: string) => filterEntries(list, q).map((e) => e.name);

  it("keeps everything for an empty query", () => {
    expect(names("  ")).toHaveLength(3);
  });

  it("matches the name and the folder, case and accents aside", () => {
    expect(names("brack")).toEqual(["Bracket"]);
    expect(names("ACME")).toEqual(["Bracket"]);
    expect(names("zurich")).toEqual(["Gear"]);
    expect(names("parts")).toEqual(["Gear", "Lever"]);
  });

  it("needs every word to match", () => {
    expect(names("parts lev")).toEqual(["Lever"]);
    expect(names("parts nope")).toEqual([]);
  });
});

describe("folderEntries", () => {
  it("makes a card per listed document, with the open time it also has in Recent", () => {
    const files = [
      { path: "D:/proj/a.funda", exists: true, mtimeMs: 50, size: 1 },
      { path: "D:/proj/sub/b.fundab", exists: true, mtimeMs: 70, size: 1 },
    ];
    const out = folderEntries(files, [{ path: "D:/proj/a.funda", openedAt: 9 }], "D:/proj/sub/b.fundab");
    expect(out).toEqual([
      { path: "D:/proj/a.funda", name: "a", folder: "D:/proj", openedAt: 9, editedAt: 50, missing: false, open: false },
      { path: "D:/proj/sub/b.fundab", name: "b", folder: "proj/sub", openedAt: null, editedAt: 70, missing: false, open: true },
    ]);
  });

  it("sorts a folder by edit time where Recent would sort by open time", () => {
    expect(folderSort("opened")).toBe("edited");
    expect(folderSort("edited")).toBe("edited");
    expect(folderSort("name")).toBe("name");
  });
});

describe("folderName", () => {
  it("is the last folder, dots kept", () => {
    expect(folderName("D:/work/my.parts")).toBe("my.parts");
    expect(folderName("D:/work/gearbox/")).toBe("gearbox");
    expect(folderName("/")).toBe("/");
  });
});
