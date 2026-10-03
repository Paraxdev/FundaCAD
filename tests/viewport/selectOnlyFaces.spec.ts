// Selecting several faces as one change: what Select tangent faces uses, so a
// listener hears the whole run once instead of one face and then the rest.

import { describe, expect, it } from "vitest";
import { Viewport } from "../../src/viewport/viewport";

function bare() {
  const selected = new Set<number>();
  let announced = 0;
  const vp = Object.create(Viewport.prototype) as Viewport;
  Object.assign(vp, {
    highlighter: {
      clearSelection: () => selected.clear(),
      toggleSelectFace: (f: number) => { if (!selected.delete(f)) selected.add(f); },
    },
    requestRender: () => {},
  });
  vp.onSelectionChange = () => { announced++; };
  return { vp, selected, announced: () => announced };
}

describe("selectOnlyFaces", () => {
  it("replaces the selection with every face and announces it once", () => {
    const b = bare();
    b.selected.add(99);
    b.vp.selectOnlyFaces([10, 11, 12]);
    expect([...b.selected]).toEqual([10, 11, 12]);
    expect(b.announced()).toBe(1);
  });

  it("selects a face named twice, rather than toggling it back off", () => {
    const b = bare();
    b.vp.selectOnlyFaces([10, 11, 10]);
    expect([...b.selected]).toEqual([10, 11]);
  });

  it("is what selectOnlyFace does for one face", () => {
    const b = bare();
    b.vp.selectOnlyFace(7);
    expect([...b.selected]).toEqual([7]);
    expect(b.announced()).toBe(1);
  });
});
