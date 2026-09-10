// The chip that says what the box being dragged will take.
//
// What is pinned here is the part that has nothing to do with a canvas: that it
// is absent unless a box is actually being dragged, that it names the filter the
// viewport reports, and that it keeps clear of the box whichever of the four
// ways the box was drawn. The last one is the reason it exists as a component
// rather than as two lines inside AreaBox, and it is exactly the kind of sign
// arithmetic that is wrong half the time and invisible in a screenshot.
//
// happy-dom reports every width as 0, so the placement here is the FALLBACK
// size the component carries for its first frame. That is honest: it is the
// same code path a real first frame takes, and the measured path is covered in
// a browser by e2e/area_select_e2e.cjs.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import AreaFilterChip from "../../../src/components/overlays/AreaFilterChip.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { AreaFilter } from "../../../src/viewport/areaSelect";

enableAutoUnmount(afterEach);

type Drag = {
  rect: { x0: number; y0: number; x1: number; y1: number };
  mode: "window" | "crossing";
  from: { x: number; y: number };
  at: { x: number; y: number };
} | null;

let drag: Drag = null;
let takes: AreaFilter = "all";

const engine = {
  viewport: {
    get areaDragState() { return drag; },
    get areaTakes() { return takes; },
  },
} as unknown as Engine;

/** Mount, then run the frames the rAF loop would. happy-dom's rAF is not driven
 *  by anything here, so the component's own pointerdown wake-up is what starts
 *  it and a real frame is awaited rather than faked. */
async function show(): Promise<HTMLElement | null> {
  window.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  await new Promise((r) => setTimeout(r, 0));
  return document.querySelector<HTMLElement>(".areachip");
}

const box = (from: [number, number], at: [number, number], mode: "window" | "crossing" = "window") => {
  drag = {
    rect: { x0: Math.min(from[0], at[0]), y0: Math.min(from[1], at[1]),
            x1: Math.max(from[0], at[0]), y1: Math.max(from[1], at[1]) },
    mode,
    from: { x: from[0], y: from[1] },
    at: { x: at[0], y: at[1] },
  };
};

describe("AreaFilterChip", () => {
  beforeEach(() => {
    drag = null;
    takes = "all";
    document.body.innerHTML = "";
    mount(AreaFilterChip, { global: { provide: { [ENGINE as symbol]: engine } } });
  });

  it("is not in the DOM at all when no box is being dragged", async () => {
    // Never a hidden element: this floats over the viewport, and one left in the
    // DOM would take the pointerup that ends the very box it describes.
    expect(await show()).toBeNull();
  });

  it("names the filter the viewport is running", async () => {
    for (const [f, word] of [
      ["all", "Everything"], ["faces", "Faces"], ["edges", "Edges"], ["bodies", "Bodies"],
    ] as const) {
      takes = f;
      box([100, 100], [300, 300]);
      const chip = await show();
      expect(chip?.dataset.filter).toBe(f);
      expect(chip?.textContent).toContain(word);
    }
  });

  it("says which verdict the drag direction chose", async () => {
    box([100, 100], [300, 300], "window");
    expect((await show())?.textContent).toContain("fully inside");
    box([300, 300], [100, 100], "crossing");
    expect((await show())?.textContent).toContain("touched");
  });

  it("stays on the far side of the cursor from the box, all four ways", async () => {
    // The cursor is at 400,400 every time and the box is drawn from a different
    // corner, so the chip has to move to a different side each time or it is
    // sitting on top of the geometry being selected.
    const corner = async (from: [number, number]) => {
      box(from, [400, 400]);
      const chip = await show();
      return { left: parseFloat(chip!.style.left), top: parseFloat(chip!.style.top) };
    };
    const downRight = await corner([100, 100]); // dragging down-right
    const upLeft = await corner([700, 700]); // dragging up-left
    const downLeft = await corner([700, 100]);
    const upRight = await corner([100, 700]);

    expect(downRight.left).toBeGreaterThan(400);
    expect(downRight.top).toBeGreaterThan(400);
    expect(upLeft.left).toBeLessThan(400);
    expect(upLeft.top).toBeLessThan(400);
    expect(downLeft.left).toBeLessThan(400);
    expect(downLeft.top).toBeGreaterThan(400);
    expect(upRight.left).toBeGreaterThan(400);
    expect(upRight.top).toBeLessThan(400);
  });

  it("stays on screen even when the cursor is at the very edge", async () => {
    // CONTROL on the rule above: keeping clear of the box must not win over
    // being visible, or the chip is pushed off the screen exactly when the box
    // is being dragged to the far corner.
    box([100, 100], [window.innerWidth - 1, window.innerHeight - 1]);
    const chip = await show();
    expect(parseFloat(chip!.style.left)).toBeLessThan(window.innerWidth);
    expect(parseFloat(chip!.style.left)).toBeGreaterThanOrEqual(0);
    expect(parseFloat(chip!.style.top)).toBeLessThan(window.innerHeight);
    expect(parseFloat(chip!.style.top)).toBeGreaterThanOrEqual(0);
  });
});
