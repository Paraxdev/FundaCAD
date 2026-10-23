import { afterEach, describe, expect, it } from "vitest";
import { panelStack } from "../../src/ui/panelStack";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;

/** A panel whose own scroller keeps its box at the cap, the way the Stress panel does. */
function panel(natural: number, scrolls: boolean) {
  const el = document.createElement("div");
  const height = () => {
    const cap = parseFloat(el.style.maxHeight);
    return scrolls && Number.isFinite(cap) ? Math.min(natural, cap) : natural;
  };
  Object.defineProperty(el, "scrollHeight", { get: height });
  Object.defineProperty(el, "offsetHeight", { get: height });
  Object.defineProperty(el, "clientHeight", { get: height });
  document.body.append(el);
  return el;
}

const frame = () => new Promise((r) => requestAnimationFrame(r));

afterEach(() => {
  for (const id of panelStack.ids()) panelStack.remove(id);
  document.body.replaceChildren();
});

describe("the panel column with a panel that scrolls inside", () => {
  it("keeps the same cap on every pass instead of flipping between capped and whole", async () => {
    const layer = document.createElement("div");
    layer.id = "float-layer";
    layer.getBoundingClientRect = () => ({ left: 0, right: 1440, top: 0, bottom: 900 }) as DOMRect;
    document.body.append(layer);
    const els = [panel(326, false), panel(138, false), panel(657, true)];
    els.forEach((el, i) => panelStack.add(`p${i}`, el));
    const first = els.map((e) => e.style.maxHeight);
    expect(first[2]).not.toBe("");
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new Event("resize"));
      await frame();
      expect(els.map((e) => e.style.maxHeight)).toEqual(first);
    }
  });
});
