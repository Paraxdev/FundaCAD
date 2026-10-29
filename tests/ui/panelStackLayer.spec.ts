import { afterEach, describe, expect, it } from "vitest";
import { panelStack } from "../../src/ui/panelStack";
import { MARGIN } from "../../src/viewport/viewCube";

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

/** The float layer with one right card, ending `right` px from the left of the window. */
function layer(right: { at: number }) {
  const el = document.createElement("div");
  el.id = "float-layer";
  el.getBoundingClientRect = () => ({ left: 0, right: right.at, top: 0, bottom: 900 }) as DOMRect;
  const col = document.createElement("div");
  col.className = "float-right";
  const card = document.createElement("div");
  card.getBoundingClientRect = () => ({ left: right.at - CARD, right: right.at, top: 12, bottom: 600 }) as DOMRect;
  col.append(card);
  el.append(col);
  document.body.append(el);
  return { el, cardLeft: () => right.at - CARD };
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

  it("narrows a panel to the span between the rail and the cards, so it never slides under the rail", async () => {
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
