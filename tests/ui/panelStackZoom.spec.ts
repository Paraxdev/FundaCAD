import { afterEach, describe, expect, it, vi } from "vitest";

const zoom = vi.hoisted(() => ({ z: 1.75 }));
vi.mock("../../src/ui/interfaceSize", () => ({ pageZoom: () => zoom.z }));

import { columnsUnderZoom, layoutStack, panelStack, stackTop } from "../../src/ui/panelStack";
import { MARGIN } from "../../src/viewport/viewCube";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

// A 1400 by 900 window at interface size 175%: rects and the root's clientWidth come in window pixels.
const Z = 1.75;
const WIN_WIDTH = 1400;
Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, get: () => WIN_WIDTH });

const frame = () => new Promise((r) => requestAnimationFrame(r));
const AREA = { left: 0, right: 1400, top: 70, bottom: 900 };
const CARD = { left: 980, right: 1375.5, top: 82.25, bottom: 600 };

function layer() {
  const el = document.createElement("div");
  el.id = "float-layer";
  el.getBoundingClientRect = () => AREA as DOMRect;
  const col = document.createElement("div");
  col.className = "float-right";
  const card = document.createElement("div");
  card.getBoundingClientRect = () => CARD as DOMRect;
  col.append(card);
  el.append(col);
  document.body.append(el);
}

/** A panel `height` CSS px tall and 340 wide. */
function panel(height: number) {
  const el = document.createElement("div");
  for (const k of ["scrollHeight", "offsetHeight", "clientHeight"]) Object.defineProperty(el, k, { get: () => height });
  Object.defineProperty(el, "offsetWidth", { get: () => 340 });
  document.body.append(el);
  return el;
}

afterEach(() => {
  for (const id of panelStack.ids()) panelStack.remove(id);
  document.body.replaceChildren();
});

describe("the panel column under the root zoom", () => {
  it("takes the layer and the cards from window pixels into CSS pixels", () => {
    const [col] = columnsUnderZoom(AREA, { left: [], right: [CARD] }, Z);
    expect(col!.top).toBeCloseTo(stackTop({ left: 0, right: 800, top: 40, bottom: 900 / Z }));
    expect(col!.bottom).toBeCloseTo(900 / Z - MARGIN);
    expect(col!.free.left).toBeCloseTo(MARGIN);
    expect(col!.free.right).toBeCloseTo(980 / Z - MARGIN);
  });

  it("puts the shelf under a card at the card's CSS bottom", () => {
    const shelf = columnsUnderZoom(AREA, { left: [], right: [CARD] }, Z).at(-1)!;
    expect(shelf.top).toBeCloseTo(600 / Z + MARGIN);
    expect(shelf.free.left).toBeCloseTo(MARGIN);
    expect(shelf.free.right).toBeCloseTo(800 - MARGIN);
  });

  it("caps a tall panel so it ends inside the layer's CSS bottom", () => {
    const [col] = columnsUnderZoom(AREA, { left: [], right: [CARD] }, Z);
    const [slot] = layoutStack([{ id: "p", height: 900 }], col!.top, col!.bottom);
    expect(slot!.top + slot!.maxHeight!).toBeLessThanOrEqual(900 / Z - MARGIN);
  });

  it("places a panel in CSS pixels, so it sits under the cube and ends inside the window", async () => {
    layer();
    const p = panel(900);
    panelStack.add("tall", p);
    await frame();
    const top = stackTop({ left: 0, right: 800, top: 70 / Z, bottom: 900 / Z });
    expect(parseFloat(p.style.top)).toBe(Math.round(top));
    expect(parseFloat(p.style.top) + parseFloat(p.style.maxHeight)).toBeLessThanOrEqual(900 / Z - MARGIN);
    expect(parseFloat(p.style.right)).toBe(Math.round(800 - (980 / Z - MARGIN)));
  });

  it("leaves the layout at 100% as it was", async () => {
    zoom.z = 1;
    try {
      layer();
      const p = panel(900);
      panelStack.add("tall", p);
      await frame();
      const top = stackTop({ left: 0, right: 1400, top: 70, bottom: 900 });
      expect(parseFloat(p.style.top)).toBe(Math.round(top));
      expect(parseFloat(p.style.maxHeight)).toBe(Math.floor(900 - MARGIN - top));
      expect(parseFloat(p.style.right)).toBe(Math.round(1400 - (980 - MARGIN)));
    } finally {
      zoom.z = Z;
    }
  });
});
