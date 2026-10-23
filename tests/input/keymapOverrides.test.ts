import { afterEach, describe, expect, it } from "vitest";
import {
  checkShortcut,
  describeShortcutProblem,
  keyHint,
  resolveShortcut,
  setShortcutOverrides,
  shortcutConflicts,
  shortcutHudGroups,
} from "../../src/input/shortcuts";
import { setPointerBindings } from "../../src/viewport/navigator/bindings";

afterEach(() => {
  setShortcutOverrides([]);
  setPointerBindings(null);
});

const row = (group: string, key: string) =>
  shortcutHudGroups()
    .find((g) => g.name === group)
    ?.rows.find((r) => r.key === key);

describe("moving a key", () => {
  it("rebinds fillet to G in the model and frees F", () => {
    expect(setShortcutOverrides([{ action: "fillet", key: "g" }])).toEqual([]);
    expect(resolveShortcut("g", false, "model")).toBe("fillet");
    expect(resolveShortcut("f", false, "model")).toBe(null);
    expect(resolveShortcut("g", false, "sketch")).toBe("tangent");
    expect(keyHint("fillet")).toBe("G");
    expect(row("Model", "G")).toMatchObject({ key: "G", label: "Fillet", changed: true });
  });

  it("binds a contributed action, globally unless told otherwise", () => {
    setShortcutOverrides([{ action: "navigation.radial", key: "w", label: "Radial menu" }]);
    expect(resolveShortcut("w", false, "model")).toBe("navigation.radial");
    expect(resolveShortcut("w", false, "sketch")).toBe("navigation.radial");
    expect(row("Global", "W")?.label).toBe("Radial menu");
  });

  it("restores the table when cleared", () => {
    setShortcutOverrides([{ action: "fillet", key: "g" }]);
    setShortcutOverrides([]);
    expect(resolveShortcut("f", false, "model")).toBe("fillet");
    expect(resolveShortcut("arrowleft", false, "model")).toBe("view-step-left");
  });
});

describe("conflicts", () => {
  it("names the action already on the key", () => {
    const p = checkShortcut({ action: "fillet", key: "e" });
    expect(p && "conflict" in p && p.conflict.action).toBe("extrude");
    expect(describeShortcutProblem(p!)).toBe("E is already used by Extrude");
  });

  it("counts a global key against model and sketch keys", () => {
    const p = checkShortcut({ action: "fillet", key: "arrowleft" });
    expect(p && "conflict" in p && p.conflict.action).toBe("view-step-left");
  });

  it("applies a clashing key, prefers it over the table's own use, and lists the clash on the sheet", () => {
    const out = setShortcutOverrides([{ action: "fillet", key: "e" }]);
    expect(out.map((o) => o.action)).toEqual(["fillet"]);
    expect(resolveShortcut("e", false, "model")).toBe("fillet");
    expect(shortcutConflicts().length).toBe(1);
    expect(shortcutHudGroups()[0]!.name).toBe("Conflicts");
  });

  it("allows a swap", () => {
    expect(
      setShortcutOverrides([
        { action: "fillet", key: "e" },
        { action: "extrude", key: "f" },
      ]),
    ).toEqual([]);
    expect(resolveShortcut("e", false, "model")).toBe("fillet");
    expect(resolveShortcut("f", false, "model")).toBe("extrude");
  });

  it("refuses the keys handled before the table and Alt", () => {
    for (const [o, what] of [
      [{ action: "fillet", key: "s", ctrl: true }, "Save"],
      [{ action: "fillet", key: "z", ctrl: true }, "Undo"],
      [{ action: "fillet", key: "escape" }, "Cancel"],
      [{ action: "fillet", key: "tab" }, "Box select filter"],
      [{ action: "fillet", key: "?" }, "This sheet"],
    ] as const) {
      expect(checkShortcut(o)).toEqual({ reserved: what });
    }
    expect(checkShortcut({ action: "fillet", key: "g", alt: true })).toHaveProperty("refused");
    const out = setShortcutOverrides([{ action: "fillet", key: "s", ctrl: true }]);
    expect(out).toEqual([{ action: "fillet", problem: { reserved: "Save" } }]);
    expect(resolveShortcut("s", false, "model", true)).toBe(null);
    expect(keyHint("fillet")).toBe("F");
  });
});

describe("the sheet's mouse rows", () => {
  it("follow the active binding table", () => {
    const mouse = () => shortcutHudGroups().find((g) => g.name === "Mouse")!.rows;
    expect(mouse().slice(0, 4)).toEqual([
      { key: "Shift+right drag", label: "Pan" },
      { key: "Right drag", label: "Orbit" },
      { key: "Middle drag", label: "Pan" },
      { key: "Right click", label: "The context menu" },
    ]);
    setPointerBindings([
      { button: "middle", drag: "orbit" },
      { button: "right", click: "menu" },
    ]);
    expect(mouse()[0]).toEqual({ key: "Middle drag", label: "Orbit", changed: true });
  });
});
