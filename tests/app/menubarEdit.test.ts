import { describe, expect, it } from "vitest";
import { buildMenubar } from "../../src/app/menubarDef";
import type { Engine } from "../../src/app/engine";

describe("the Edit menu", () => {
  const rows = () =>
    buildMenubar({} as Engine)
      .find((m) => m.label === "Edit")!
      .items.map((i) => (i.separator ? "-" : (i.refName ?? i.label)));

  // A short window or a large interface caps the menu's height and scrolls the rest, so Preferences, the way to
  // Accessibility, keeps the place it had before the geometry rows came.
  it("shows Preferences above the geometry rows", () => {
    expect(rows().slice(0, 8)).toEqual([
      "Undo",
      "Redo",
      "-",
      "Delete",
      "Suppress / Unsuppress",
      "-",
      "Materials",
      "Preferences…",
    ]);
  });

  it("still lists the geometry rows, after a separator", () => {
    expect(rows().slice(8)).toEqual([
      "-",
      "Next Face",
      "Previous Face",
      "Next Edge",
      "Previous Edge",
      "Browse Faces and Edges",
    ]);
  });
});
