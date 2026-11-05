import { afterEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import FpsReadout from "../../../src/components/shell/FpsReadout.vue";
import { cardRects, promptInsets, seenRect, type Box } from "../../../src/ui/promptPlacement";

enableAutoUnmount(afterEach);

const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });
const at = (el: Element, b: Box) =>
  (el.getBoundingClientRect = () =>
    ({ ...b, x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top, toJSON: () => b }) as DOMRect);
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

// A tool rail whose list scrolls: Line shows whole, Fillet half, Construction is scrolled out below.
function rail() {
  const layer = document.createElement("div");
  layer.id = "float-layer";
  layer.innerHTML =
    '<div class="tool-rail"><div class="rail-list" style="overflow-y: auto">' +
    '<button class="rail-btn">Line</button><button class="rail-btn">Fillet</button>' +
    '<button class="rail-btn">Construction</button></div><button class="rail-btn pinned">Exit</button></div>';
  document.body.append(layer);
  const [list, line, fillet, construction, pinned] = [
    ".rail-list",
    ".rail-btn:nth-child(1)",
    ".rail-btn:nth-child(2)",
    ".rail-btn:nth-child(3)",
    ".pinned",
  ].map((s) => layer.querySelector(s)!);
  at(list!, box(288, 48, 440, 400));
  at(line!, box(288, 300, 400, 332));
  at(fillet!, box(288, 380, 420, 412));
  at(construction!, box(288, 452, 436, 484));
  at(pinned!, box(288, 700, 412, 732));
  return { layer, list: list!, line: line!, fillet: fillet!, construction: construction! };
}

afterEach(() => document.getElementById("float-layer")?.remove());

describe("seenRect", () => {
  it("cuts a tool to the part its scrolling rail shows", () => {
    const r = rail();
    expect(seenRect(r.line)).toEqual(box(288, 300, 400, 332));
    expect(seenRect(r.fillet)).toEqual(box(288, 380, 420, 400));
  });

  it("leaves a tool scrolled out of the rail empty, so no row makes room for its label", () => {
    rail();
    const rects = cardRects("#float-layer .rail-btn");
    expect(rects[2]!.bottom).toBeLessThanOrEqual(rects[2]!.top);
    const band = { top: 452, bottom: 484 };
    expect(promptInsets(box(0, 0, 1000, 800), band, { left: rects, right: [] }, 12, 0).left).toBe(12);
  });

  it("does not cut by an ancestor that only hides its overflow", () => {
    const card = document.createElement("div");
    card.style.overflow = "hidden";
    const inner = document.createElement("span");
    card.append(inner);
    document.body.append(card);
    at(card, box(0, 0, 100, 100));
    at(inner, box(0, 80, 100, 140));
    expect(seenRect(inner)).toEqual(box(0, 80, 100, 140));
    card.remove();
  });
});

describe("the frame rate readout", () => {
  const engine = { viewport: { attachFpsHost: vi.fn() } } as unknown as Engine;

  function render(chip: Box) {
    const w = mount(FpsReadout, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
    at(w.element.parentElement!, box(0, 0, 1000, 760));
    at(w.element, chip);
    return w;
  }

  it("moves clear of a rail tile in its row and slides back to the middle as far as it can", async () => {
    rail();
    const w = render(box(450, 712, 550, 734));
    await frames();
    const style = (w.element as HTMLElement).style;
    // The pinned tile ends at 412, so the span is 424..988; the middle would start the 100 wide chip at 450.
    expect(style.getPropertyValue("--span-left")).toBe("424px");
    expect(style.getPropertyValue("--span-right")).toBe("12px");
    expect(style.getPropertyValue("--span-shift")).toBe(`${450 - (424 + (988 - 424 - 100) / 2)}px`);
  });

  it("stays in the middle when nothing in its row is in the way", async () => {
    rail();
    const w = render(box(450, 760 - 16 - 22, 550, 760 - 16));
    at(document.querySelector(".pinned")!, box(288, 600, 412, 632));
    await frames();
    const style = (w.element as HTMLElement).style;
    expect(style.getPropertyValue("--span-left")).toBe("12px");
    expect(style.getPropertyValue("--span-shift")).toBe("0px");
  });
});
