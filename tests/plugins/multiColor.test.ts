// The multi-colour capability's pure half.
//
// These four cases were in tests/io/files.test.ts, because the function they
// cover was in src/io/files.ts, because the import path was the one thing that
// called it. It was never about importing a file: it is about what a palette
// slot is and when a colour is close enough to one, which is this capability's
// whole subject and now lives in its directory.

import { describe, it, expect } from "vitest";

import { bodyColorMenuItems, nearestPaletteSlot, paintFrom, staleSlots } from "../../plugins/FundaCAD.MultiColor/palette";
import type { DocumentStore } from "../../src/document/store";

describe("nearestPaletteSlot", () => {
  // the shipped default palette
  const pal = [
    { name: "White", color: "#e8e8e8" },
    { name: "Black", color: "#202020" },
    { name: "Red", color: "#d23b30" },
    { name: "Blue", color: "#3050c8" },
  ];

  it("picks the exact slot when the colour is already in the palette", () => {
    expect(nearestPaletteSlot("#d23b30", pal)).toBe(2);
    expect(nearestPaletteSlot("#3050C8", pal)).toBe(3);
  });

  it("picks the perceptually closest slot for a colour that is not", () => {
    expect(nearestPaletteSlot("#ff0000", pal)).toBe(2); // crimson -> Red
    expect(nearestPaletteSlot("#0000aa", pal)).toBe(3); // navy -> Blue
    expect(nearestPaletteSlot("#fdfdfd", pal)).toBe(0); // near-white -> White
    expect(nearestPaletteSlot("#010101", pal)).toBe(1); // near-black -> Black
  });

  it("returns null rather than guessing on bad input", () => {
    expect(nearestPaletteSlot("#d23b30", [])).toBeNull();
    expect(nearestPaletteSlot("not-a-colour", pal)).toBeNull();
    expect(nearestPaletteSlot("#abc", pal)).toBeNull(); // 3-digit form unsupported
  });

  it("never invents a slot beyond the palette, it matches, never extends", () => {
    // the palette is the U1's 4 physical filament slots, not a display palette
    for (const c of ["#123456", "#00ff00", "#ffff00", "#7f7f7f"]) {
      const slot = nearestPaletteSlot(c, pal);
      expect(slot).not.toBeNull();
      expect(slot!).toBeGreaterThanOrEqual(0);
      expect(slot!).toBeLessThan(pal.length);
    }
  });
});

describe("the body colour menu", () => {
  /** Just enough store for a menu: a palette, and one body's slot. */
  function fakeStore(slot: number | null): DocumentStore {
    let current = slot;
    return {
      colorPalette: [
        { name: "White", color: "#e8e8e8" },
        { name: "Red", color: "#d23b30" },
      ],
      bodyColorSlot: () => (current == null ? undefined : current),
      setBodyColorSlot: (_id: string, s: number | null) => { current = s; },
    } as unknown as DocumentStore;
  }

  it("offers every slot, plus None, and disables the one already chosen", () => {
    const items = bodyColorMenuItems(fakeStore(1), "b1");
    expect(items.map((i) => i.label)).toEqual(["White", "Red", "None"]);
    expect(items.map((i) => i.disabled)).toEqual([false, true, false]);
    // the swatch is what makes it readable as a colour menu rather than a list
    expect(items[0]!.swatch).toBe("#e8e8e8");
  });

  it("disables None instead when the body has no slot", () => {
    const items = bodyColorMenuItems(fakeStore(null), "b1");
    expect(items.map((i) => i.disabled)).toEqual([false, false, true]);
  });

  it("assigns the slot that was clicked", () => {
    const store = fakeStore(null);
    const items = bodyColorMenuItems(store, "b1");
    items[1]!.onClick!();
    expect(bodyColorMenuItems(store, "b1")[1]!.disabled).toBe(true);
  });
});

describe("what the viewport is told to paint", () => {
  const store = (bodies: unknown[], slots: Record<string, number>) => ({
    colorPalette: [{ name: "White", color: "#e8e8e8" }, { name: "Red", color: "#d23b30" }],
    buildState: { result: { bodies } },
    bodyColorSlot: (id: string) => slots[id],
  }) as unknown as DocumentStore;

  it("gives a body the colour of the slot it was assigned", () => {
    const p = paintFrom(store([{ id: "b1", faceStart: 0 }, { id: "b2", faceStart: 4 }], { b1: 1 }));
    expect(p.bodies).toEqual({ b1: "#d23b30" });
    // The control: an unassigned body is ABSENT, not painted a default. The
    // viewport's own material is what an unpainted body should look like.
    expect(p.bodies.b2).toBeUndefined();
  });

  it("turns a body's dense texture-slot array into global face indices", () => {
    // faceStart 4 and a slot on the body's third face is global face 6, which is
    // the whole reason this is not just a copy of the array.
    const p = paintFrom(
      store([{ id: "b1", faceStart: 4, textureColorSlots: [null, null, 0, 1] }], {}),
    );
    expect(p.faces).toEqual({ 6: "#e8e8e8", 7: "#d23b30" });
  });

  it("ignores a slot the palette does not have", () => {
    // A document saved with a longer palette, opened after it was shortened.
    const p = paintFrom(store([{ id: "b1", faceStart: 0 }], { b1: 9 }));
    expect(p.bodies).toEqual({});
  });
});

describe("staleSlots", () => {
  // Slot 1 wears the name an unlabelled toolhead derives, so the fixture is a
  // machine that AGREES with the palette; every case below is one change to it.
  const pal = [{ name: "Polymaker PLA", color: "#d23b30" }, { name: "Toolhead 2", color: "#e8e8e8" }];
  const loaded = (over: Partial<{ vendor: string; material: string; color: string; present: boolean }>[]) =>
    over.map((o, i) => ({
      index: i, present: true, vendor: "Polymaker", material: "PLA", color: "#d23b30", ...o,
    }));

  it("says nothing is stale when the machine matches the palette", () => {
    expect(staleSlots(pal, loaded([{}, { vendor: "", material: "", color: "#e8e8e8" }]))).toEqual([]);
  });

  it("names the slot whose colour drifted", () => {
    expect(staleSlots(pal, loaded([{ color: "#00ff00" }, { vendor: "", material: "", color: "#e8e8e8" }]))).toEqual([0]);
  });

  it("says nothing about a toolhead with nothing in it", () => {
    // An empty toolhead is not a disagreement, the sync leaves that slot alone,
    // so calling it stale would light the dot amber forever on a machine with
    // three of its four heads unloaded.
    expect(staleSlots(pal, loaded([{ present: false, color: "#00ff00" }, { vendor: "", material: "", color: "#e8e8e8" }]))).toEqual([]);
  });

  it("says nothing about a toolhead the palette has no slot for", () => {
    expect(staleSlots([pal[0]!], loaded([{}, { color: "#00ff00" }]))).toEqual([]);
  });
});
