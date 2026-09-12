// The file-manager click rules the Browser's lists share (src/ui/rowSelection.ts).
import { describe, expect, it } from "vitest";
import { actOn, EMPTY_SELECTION, modsOf, selectRow, type RowSelection } from "../../src/ui/rowSelection";

const ORDER = ["a", "b", "c", "d", "e"];
const plain = { toggle: false, range: false };
const ctrl = { toggle: true, range: false };
const shift = { toggle: false, range: true };
const ctrlShift = { toggle: true, range: true };

describe("selectRow", () => {
  it("a plain click selects that row alone and anchors on it", () => {
    const sel: RowSelection<string> = { keys: ["a", "c"], anchor: "a" };
    expect(selectRow(sel, ORDER, "d", plain)).toEqual({ keys: ["d"], anchor: "d" });
  });

  it("Ctrl adds a row, and a second Ctrl-click takes it back out", () => {
    const one = selectRow(EMPTY_SELECTION, ORDER, "b", plain);
    const two = selectRow(one, ORDER, "d", ctrl);
    expect(two).toEqual({ keys: ["b", "d"], anchor: "d" });
    expect(selectRow(two, ORDER, "b", ctrl)).toEqual({ keys: ["d"], anchor: "b" });
  });

  it("Shift takes the run from the anchor, in drawn order, either direction", () => {
    const anchored = selectRow(EMPTY_SELECTION, ORDER, "b", plain);
    expect(selectRow(anchored, ORDER, "d", shift).keys).toEqual(["b", "c", "d"]);
    const up = selectRow(EMPTY_SELECTION, ORDER, "d", plain);
    expect(selectRow(up, ORDER, "a", shift).keys).toEqual(["a", "b", "c", "d"]);
  });

  it("a second Shift-click re-measures from the SAME anchor, so the run can shrink", () => {
    const anchored = selectRow(EMPTY_SELECTION, ORDER, "b", plain);
    const wide = selectRow(anchored, ORDER, "e", shift);
    const narrow = selectRow(wide, ORDER, "c", shift);
    expect(narrow).toEqual({ keys: ["b", "c"], anchor: "b" });
  });

  it("Ctrl+Shift adds the run to what was already selected", () => {
    let sel = selectRow(EMPTY_SELECTION, ORDER, "a", plain);
    sel = selectRow(sel, ORDER, "c", ctrl); // anchor moves to c
    sel = selectRow(sel, ORDER, "e", ctrlShift);
    expect(sel.keys).toEqual(["a", "c", "d", "e"]);
  });

  it("a Shift-click with no drawn anchor selects just the clicked row", () => {
    expect(selectRow(EMPTY_SELECTION, ORDER, "c", shift)).toEqual({ keys: ["c"], anchor: "c" });
    // the anchor's row is inside a collapsed folder now, so it is not in the order
    const stale: RowSelection<string> = { keys: ["x"], anchor: "x" };
    expect(selectRow(stale, ORDER, "c", shift)).toEqual({ keys: ["c"], anchor: "c" });
  });
});

describe("actOn", () => {
  it("acts on the whole selection when the grabbed row is in it, else on that row", () => {
    expect(actOn(["a", "b"], "b")).toEqual(["a", "b"]);
    expect(actOn(["a", "b"], "c")).toEqual(["c"]);
  });
});

describe("modsOf", () => {
  it("reads Cmd as Ctrl", () => {
    expect(modsOf({ ctrlKey: false, metaKey: true, shiftKey: false })).toEqual({ toggle: true, range: false });
    expect(modsOf({ ctrlKey: false, metaKey: false, shiftKey: true })).toEqual({ toggle: false, range: true });
  });
});
