import { afterEach, describe, expect, it } from "vitest";
import {
  checkRow,
  resetUserShortcuts,
  resolveShortcut,
  setUserShortcut,
  shortcutHudGroups,
  userShortcutIds,
} from "../../src/input/shortcuts";

afterEach(() => resetUserShortcuts());

const FILLET = "fillet|model|F";
const EXTRUDE = "extrude|model|E";
const row = (id: string) =>
  shortcutHudGroups()
    .flatMap((g) => g.rows)
    .find((r) => r.id === id);

describe("a key a person chose", () => {
  it("moves one row, frees its old key and marks the row changed", () => {
    expect(setUserShortcut(FILLET, { key: "g" })).toBeNull();
    expect(resolveShortcut("g", false, "model")).toBe("fillet");
    expect(resolveShortcut("f", false, "model")).toBeNull();
    expect(row(FILLET)).toMatchObject({ key: "G", changed: true });
    expect(userShortcutIds()).toEqual([FILLET]);
  });

  it("moves only that context, the sketch row keeps its key", () => {
    setUserShortcut(EXTRUDE, { key: "w" });
    expect(resolveShortcut("w", false, "model")).toBe("extrude");
    expect(resolveShortcut("e", false, "sketch")).toBe("extrude");
  });

  it("is dropped when the key goes back to the shipped one", () => {
    setUserShortcut(FILLET, { key: "g" });
    setUserShortcut(FILLET, { key: "f" });
    expect(userShortcutIds()).toEqual([]);
    expect(row(FILLET)?.changed).toBeUndefined();
  });

  it("is undone by a reset, of one row or of a list", () => {
    setUserShortcut(FILLET, { key: "g" });
    setUserShortcut("measure|model|I", { key: "j" });
    resetUserShortcuts([FILLET]);
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(userShortcutIds()).toEqual(["measure|model|I"]);
    resetUserShortcuts();
    expect(resolveShortcut("i", false, "model")).toBe("measure");
  });
});

describe("a key that is taken", () => {
  it("names the row holding it and changes nothing", () => {
    const p = setUserShortcut(FILLET, { key: "e" });
    expect(p && "conflict" in p && p.conflict.action).toBe("extrude");
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(userShortcutIds()).toEqual([]);
  });

  it("is only a conflict inside the same scope", () => {
    expect(checkRow("line|sketch|L", { key: "s" })).toBeNull();
    expect(checkRow("line|sketch|L", { key: "home" })).toHaveProperty("conflict");
    expect(checkRow("sketch|model|S", { key: "v" })).toBeNull();
  });

  it("is taken on request, which leaves the other row unbound", () => {
    expect(setUserShortcut(FILLET, { key: "e" }, true)).toBeNull();
    expect(resolveShortcut("e", false, "model")).toBe("fillet");
    expect(row(EXTRUDE)).toMatchObject({ key: "", changed: true });
    resetUserShortcuts([EXTRUDE]);
    expect(checkRow(EXTRUDE, { key: "e" })).toHaveProperty("conflict");
  });

  it("refuses the keys the app handles first, and Alt", () => {
    expect(setUserShortcut(FILLET, { key: "z", ctrl: true })).toEqual({ reserved: "Undo" });
    expect(setUserShortcut(FILLET, { key: "g", alt: true })).toHaveProperty("refused");
    expect(userShortcutIds()).toEqual([]);
  });
});

describe("the rows that cannot change", () => {
  it("have no id", () => {
    const all = shortcutHudGroups();
    const always = all.find((g) => g.name === "Always")!.rows;
    const mouse = all.find((g) => g.name === "Mouse")!.rows;
    expect([...always, ...mouse].some((r) => r.id)).toBe(false);
    const help = all.flatMap((g) => g.rows).find((r) => r.key === "?");
    expect(help?.id).toBeUndefined();
  });
});
