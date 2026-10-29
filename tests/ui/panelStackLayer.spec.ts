import { afterEach, describe, expect, it } from "vitest";
import { panelStack } from "../../src/ui/panelStack";
import { MARGIN } from "../../src/viewport/viewCube";
import type { Box } from "../../src/ui/promptPlacement";

const observers: RO[] = [];
class RO {
  targets = new Set<Element>();
  constructor(private cb: () => void) {
    observers.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

/** Fires the resize callback of each observer that watches `el`, and says whether any did. */
function resized(el: Element): boolean {
  const on = observers.filter((o) => o.targets.has(el));
  for (const o of on) o["cb"]();
  return on.length > 0;
}

const VIEWPORT = 1440;
const DOCK = 340;
const CARD = 260;
Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, get: () => VIEWPORT });

const frame = () => new Promise((r) => requestAnimationFrame(r));

/** A right card `from` px left of the layer's right edge. */
interface Card {
  from: number;
  width: number;
  bottom: number;
}

/** The float layer ending `right` px from the left of the window, with its right cards, one by default. */
function layer(right: { at: number }, cards: Card[] = [{ from: CARD, width: CARD, bottom: 600 }]) {
  const el = document.createElement("div");
  el.id = "float-layer";
  el.getBoundingClientRect = () => ({ left: 0, right: right.at, top: 0, bottom: 900 }) as DOMRect;
  const col = document.createElement("div");
  col.className = "float-right";
  for (const c of cards) {
    const card = document.createElement("div");
    card.getBoundingClientRect = () =>
      ({ left: right.at - c.from, right: right.at - c.from + c.width, top: 12, bottom: c.bottom }) as DOMRect;
    col.append(card);
  }
  el.append(col);
  document.body.append(el);
  return { el, cardLeft: () => right.at - Math.max(...cards.map((c) => c.from)) };
}

/** A tool rail button in the layer whose label ends `right` px from the left of the window. */
function rail(layerEl: HTMLElement, right: number) {
  const el = document.createElement("div");
  el.className = "tool-rail";
  const btn = document.createElement("div");
  btn.className = "rail-btn";
  btn.getBoundingClientRect = () => ({ left: 12, right, top: 140, bottom: 700 }) as DOMRect;
  el.append(btn);
  layerEl.append(el);
}

/** A panel 200 px tall and `width` wide, the Stress panel's width by default. */
function panel(width = 340) {
  const el = document.createElement("div");
  for (const k of ["scrollHeight", "offsetHeight", "clientHeight"]) Object.defineProperty(el, k, { get: () => 200 });
  Object.defineProperty(el, "offsetWidth", { get: () => width });
  document.body.append(el);
  return el;
}

const leftOf = (el: HTMLElement) => VIEWPORT - parseFloat(el.style.right);

/** The Items card in the layer's left stack, as tall as the layer. */
function items(layerEl: HTMLElement) {
  const stack = document.createElement("div");
  stack.className = "float-left-stack";
  const card = document.createElement("div");
  card.getBoundingClientRect = () => ({ left: 12, right: 276, top: 12, bottom: 888 }) as DOMRect;
  stack.append(card);
  layerEl.append(stack);
}

/** A panel's box in window coordinates, sized as CSS would size it from its inline min and max width. */
function boxOf(el: HTMLElement) {
  const max = el.style.maxWidth ? parseFloat(el.style.maxWidth) : Infinity;
  const width = Math.max(parseFloat(el.style.minWidth) || 0, Math.min(el.offsetWidth, max));
  const top = parseFloat(el.style.top);
  const height = el.style.maxHeight ? parseFloat(el.style.maxHeight) : el.offsetHeight;
  return { left: leftOf(el) - width, right: leftOf(el), top, bottom: top + height };
}

const overlap = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

const cards = () =>
  [...document.querySelectorAll(".float-right > *, .float-left-stack > *, .tool-rail .rail-btn")].map((c) =>
    c.getBoundingClientRect(),
  );

afterEach(() => {
  for (const id of panelStack.ids()) panelStack.remove(id);
  document.body.replaceChildren();
  observers.length = 0;
});

describe("the panel column follows the float layer", () => {
  it("moves an open panel clear of the cards when the Render dock narrows the layer", async () => {
    const right = { at: VIEWPORT };
    const { el: layerEl, cardLeft } = layer(right);
    const p = panel();
    panelStack.add("stress", p);
    expect(leftOf(p)).toBeLessThanOrEqual(cardLeft());
    right.at = VIEWPORT - DOCK;
    expect(resized(layerEl)).toBe(true);
    await frame();
    expect(leftOf(p)).toBeLessThanOrEqual(cardLeft());
    expect(parseFloat(p.style.right)).toBeGreaterThan(DOCK + CARD);
  });

  it("narrows a panel to the span between the rail and the cards, so it stays clear of the rail", async () => {
    const right = { at: VIEWPORT };
    const { el: layerEl, cardLeft } = layer(right);
    const RAIL = 500;
    rail(layerEl, RAIL);
    const p = panel();
    panelStack.add("stress", p);
    right.at = VIEWPORT - DOCK;
    resized(layerEl);
    await frame();
    expect({ right: p.style.right, maxWidth: p.style.maxWidth }).toEqual({
      right: `${VIEWPORT - (cardLeft() - MARGIN)}px`,
      maxWidth: `${cardLeft() - MARGIN - (RAIL + MARGIN)}px`,
    });
  });

  it("moves the column to the shelf right of the view controls when the span beside the rail is under the min-width", async () => {
    const right = { at: VIEWPORT };
    const view = { from: 340, width: 48, bottom: 600 };
    const history = { from: 280, width: 266, bottom: 200 };
    const { el: layerEl, cardLeft } = layer(right, [view, history]);
    const RAIL = 600;
    rail(layerEl, RAIL);
    const p = panel();
    p.style.minWidth = "180px";
    panelStack.add("stress", p);
    right.at = VIEWPORT - DOCK;
    resized(layerEl);
    await frame();
    expect(cardLeft() - MARGIN - (RAIL + MARGIN)).toBeLessThan(180);
    const shelfLeft = right.at - view.from + view.width + MARGIN;
    expect({ top: p.style.top, right: p.style.right, maxWidth: p.style.maxWidth }).toEqual({
      top: `${history.bottom + MARGIN}px`,
      right: `${VIEWPORT - (right.at - MARGIN)}px`,
      maxWidth: `${right.at - MARGIN - shelfLeft}px`,
    });
  });

  it("caps the min-width to the span beside the rail when no shelf fits it, so it stays clear of the cards", async () => {
    const right = { at: VIEWPORT };
    const { el: layerEl, cardLeft } = layer(right, [{ from: CARD, width: CARD, bottom: 900 }]);
    const RAIL = 700;
    const MIN = 180;
    rail(layerEl, RAIL);
    const p = panel();
    p.style.minWidth = `${MIN}px`;
    panelStack.add("stress", p);
    right.at = VIEWPORT - DOCK;
    resized(layerEl);
    await frame();
    const span = cardLeft() - MARGIN - (RAIL + MARGIN);
    expect(span).toBeLessThan(MIN);
    expect({ right: p.style.right, minWidth: p.style.minWidth, maxWidth: p.style.maxWidth }).toEqual({
      right: `${VIEWPORT - (cardLeft() - MARGIN)}px`,
      minWidth: `${span}px`,
      maxWidth: `${span}px`,
    });
  });

  it("leaves a panel that fits the span without an inline max-width, so its own max-width still holds", async () => {
    const right = { at: VIEWPORT };
    const { el: layerEl } = layer(right);
    rail(layerEl, 500);
    const p = panel(300);
    panelStack.add("params", p);
    right.at = VIEWPORT - DOCK;
    resized(layerEl);
    await frame();
    expect(p.style.maxWidth).toBe("");
  });

  it("stops watching the layer once no panel is open, so its resizes place nothing", async () => {
    const right = { at: VIEWPORT };
    const { el: layerEl } = layer(right);
    const p = panel();
    panelStack.add("stress", p);
    expect(resized(layerEl)).toBe(true);
    panelStack.remove("stress");
    const before = p.style.right;
    right.at = VIEWPORT - DOCK;
    expect(resized(layerEl)).toBe(false);
    await frame();
    expect(p.style.right).toBe(before);
  });
});

describe("each panel takes its own column on a stage too narrow for the widest", () => {
  const STAGE = 1058;
  const RAIL = 447;
  const view = { from: 360, width: 48, bottom: 800 };
  const history = { from: 300, width: 288, bottom: 318 };

  function stage(at: number) {
    const { el } = layer({ at }, [view, history]);
    items(el);
    rail(el, RAIL);
  }

  function params() {
    const p = panel(600);
    p.style.minWidth = "560px";
    return p;
  }

  function stress() {
    const p = panel();
    p.style.minWidth = "180px";
    return p;
  }

  const besideRight = (at: number) => at - view.from - MARGIN;

  it("keeps Stress beside the rail and moves Parameters, capped, to the widest shelf, both clear of every card", () => {
    stage(STAGE);
    const p = params();
    const s = stress();
    panelStack.add("params", p);
    panelStack.add("stress", s);
    const shelfLeft = STAGE - view.from + view.width + MARGIN;
    expect({ right: s.style.right, minWidth: s.style.minWidth, maxWidth: s.style.maxWidth }).toEqual({
      right: `${VIEWPORT - besideRight(STAGE)}px`,
      minWidth: "180px",
      maxWidth: `${besideRight(STAGE) - (RAIL + MARGIN)}px`,
    });
    expect({ top: p.style.top, right: p.style.right, minWidth: p.style.minWidth, maxWidth: p.style.maxWidth }).toEqual({
      top: `${history.bottom + MARGIN}px`,
      right: `${VIEWPORT - (STAGE - MARGIN)}px`,
      minWidth: `${STAGE - MARGIN - shelfLeft}px`,
      maxWidth: `${STAGE - MARGIN - shelfLeft}px`,
    });
    for (const el of [p, s]) for (const c of cards()) expect(overlap(boxOf(el), c)).toBe(false);
    expect(overlap(boxOf(p), boxOf(s))).toBe(false);
  });

  it("keeps Stress alone beside the rail, capped to that span, with its own min-width", () => {
    stage(STAGE);
    const s = stress();
    panelStack.add("stress", s);
    expect({ right: s.style.right, minWidth: s.style.minWidth, maxWidth: s.style.maxWidth }).toEqual({
      right: `${VIEWPORT - besideRight(STAGE)}px`,
      minWidth: "180px",
      maxWidth: `${besideRight(STAGE) - (RAIL + MARGIN)}px`,
    });
  });

  it("keeps Parameters alone beside the rail on a stage wide enough, with no inline widths of its own", () => {
    stage(VIEWPORT);
    const p = params();
    panelStack.add("params", p);
    expect(besideRight(VIEWPORT) - (RAIL + MARGIN)).toBeGreaterThanOrEqual(600);
    expect({ right: p.style.right, minWidth: p.style.minWidth, maxWidth: p.style.maxWidth }).toEqual({
      right: `${VIEWPORT - besideRight(VIEWPORT)}px`,
      minWidth: "560px",
      maxWidth: "",
    });
  });

  it("stops the column beside the rail short of a lower shelf that Parameters takes across it", () => {
    const low = { ...view, bottom: 300 };
    const { el: layerEl } = layer({ at: STAGE }, [low, { ...history, bottom: 200 }]);
    items(layerEl);
    rail(layerEl, RAIL);
    const p = params();
    const s = stress();
    panelStack.add("stress", s);
    panelStack.add("params", p);
    expect({ top: p.style.top, right: s.style.right }).toEqual({
      top: `${low.bottom + MARGIN}px`,
      right: `${VIEWPORT - besideRight(STAGE)}px`,
    });
    expect(overlap(boxOf(p), boxOf(s))).toBe(false);
    for (const el of [p, s]) for (const c of cards()) expect(overlap(boxOf(el), c)).toBe(false);
  });
});
