import { afterEach, describe, expect, it } from "vitest";
import { panelStack } from "../../src/ui/panelStack";

class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver = RO;
Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, get: () => 600 });

// History's title and tools above its list, and the Stress rows outside its scroller, as measured at 900x800.
const HEAD = 78;
const FIXED = 164;
const STEP = 400;

const frame = () => new Promise((r) => requestAnimationFrame(r));
const capOf = (el: HTMLElement) => {
  const cap = parseFloat(el.style.maxHeight);
  return Number.isFinite(cap) ? cap : Infinity;
};

function layer(bottom: number) {
  const el = document.createElement("div");
  el.id = "float-layer";
  el.getBoundingClientRect = () => ({ left: 0, right: 600, top: 0, bottom }) as DOMRect;
  const right = document.createElement("div");
  right.className = "float-right";
  el.append(right);
  document.body.append(el);
  return right;
}

/** A right card `tall` px high from y 48, with a list of `content` px when `scrolls`. Any layout read clamps the list's
 *  scroll to what it shows at that moment, as a browser does. */
function card(tall: number, content: number, scrolls = true) {
  const el = document.createElement("div");
  const list = document.createElement("div");
  list.toggleAttribute("data-card-scroll", scrolls);
  el.append(list);
  const h = () => Math.min(tall, capOf(el));
  let at = 0;
  const flush = () => (at = Math.max(0, Math.min(at, content - (h() - HEAD))));
  el.getBoundingClientRect = () => {
    flush();
    return { left: 340, right: 588, top: 48, bottom: 48 + h() } as DOMRect;
  };
  Object.defineProperty(el, "offsetHeight", { get: () => (flush(), h()) });
  for (const k of ["offsetHeight", "clientHeight"])
    Object.defineProperty(list, k, { get: () => (flush(), h() - HEAD) });
  Object.defineProperty(list, "scrollHeight", { get: () => (flush(), content) });
  Object.defineProperty(list, "scrollTop", {
    get: () => flush(),
    set: (v: number) => {
      at = v;
      flush();
    },
  });
  return { el, list };
}

function stress() {
  const el = document.createElement("div");
  el.style.minWidth = "360px";
  const step = document.createElement("div");
  step.toggleAttribute("data-panel-scroll", true);
  el.append(step);
  const h = () => Math.min(FIXED + STEP, capOf(el));
  for (const k of ["scrollHeight", "offsetHeight", "clientHeight"]) Object.defineProperty(el, k, { get: h });
  Object.defineProperty(step, "offsetHeight", { get: () => h() - FIXED });
  Object.defineProperty(step, "scrollHeight", { get: () => STEP });
  document.body.append(el);
  return el;
}

function open(bottom: number, tall: number, content = 840, scrolls = true) {
  const history = card(tall, content, scrolls);
  layer(bottom).append(history.el);
  const panel = stress();
  panelStack.add("stress", panel);
  const read = () => ({ history: history.el.style.maxHeight, top: panel.style.top, cap: panel.style.maxHeight });
  return { ...history, read };
}

afterEach(() => {
  for (const id of panelStack.ids()) panelStack.remove(id);
  document.body.replaceChildren();
});

describe("a History card above the Stress panel", () => {
  it("is cut so the shelf under it holds the panel's fixed rows and a sliver of its step", () => {
    expect(open(800, 740).read()).toEqual({ history: "520px", top: "582px", cap: "204px" });
  });

  it("stays whole when the shelf under it already holds that, one pixel either side", () => {
    expect(open(800, 520).read()).toEqual({ history: "", top: "582px", cap: "204px" });
    panelStack.remove("stress");
    document.body.replaceChildren();
    expect(open(800, 521).read()).toEqual({ history: "520px", top: "582px", cap: "204px" });
  });

  it("is cut only when the cut leaves fewer panels short, one pixel either side", () => {
    expect(open(398, 318).read()).toEqual({ history: "118px", top: "180px", cap: "204px" });
    panelStack.remove("stress");
    document.body.replaceChildren();
    expect(open(397, 318).read()).toEqual({ history: "", top: "146px", cap: "237px" });
  });

  it("is never cut when it has no list of its own to scroll", () => {
    expect(open(800, 740, 840, false).read().history).toBe("");
  });

  it("is whole again once the Stress panel closes", () => {
    const { el } = open(800, 740);
    expect(el.style.maxHeight).toBe("520px");
    panelStack.remove("stress");
    expect(el.style.maxHeight).toBe("");
  });

  it("is cut when it opens after the Stress panel", async () => {
    const right = layer(800);
    const panel = stress();
    panelStack.add("stress", panel);
    expect(panel.style.top).toBe("146px");
    const history = card(740, 840);
    right.append(history.el);
    await frame();
    await frame();
    expect({ history: history.el.style.maxHeight, top: panel.style.top, cap: panel.style.maxHeight }).toEqual({
      history: "520px",
      top: "582px",
      cap: "204px",
    });
  });
});
