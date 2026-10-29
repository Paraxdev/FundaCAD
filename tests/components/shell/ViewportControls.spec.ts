import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";
import ViewportControls from "../../../src/components/shell/ViewportControls.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { resetPathTracedOverride, type RenderTier } from "../../../src/ui/viewMode";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";
import { useUiStore } from "../../../src/stores/ui";

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetPathTracedOverride();
});

async function render(renderTier: RenderTier) {
  const handleAction = vi.fn();
  const setStandardView = vi.fn();
  const engine = {
    canvas: document.createElement("canvas"),
    handleAction,
    viewport: {
      renderTier,
      projection: "persp",
      onRenderTierChange: () => () => {},
      setViewCubeInset: () => {},
      setStandardView,
    },
    store: { buildState: {}, fileName: "Untitled", dirty: false },
    bridge: { buildVersion: ref(0), metaVersion: ref(0) },
  } as unknown as Engine;
  const w = mount(ViewportControls, { global: { provide: { [ENGINE as symbol]: engine } }, attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, handleAction, setStandardView };
}

const TIER: RenderTier = { lowPower: false, auto: false, webgpu: true };
const byText = (sel: string, text: string) =>
  [...document.querySelectorAll<HTMLElement>(sel)].find((el) => el.textContent?.trim() === text);

describe("ViewportControls Path traced button", () => {
  it("stays greyed but answers a click when a low powered computer soft blocks it", async () => {
    const { w, handleAction } = await render({ lowPower: true, auto: false, webgpu: true });
    const btn = w.get('[data-view-mode="pathtraced"]');
    await btn.trigger("click");
    expect([btn.attributes("aria-disabled"), btn.classes("is-disabled"), handleAction.mock.calls]).toEqual([
      "true",
      true,
      [["viewmode-pathtraced"]],
    ]);
  });

  it("swallows a click when the GPU cannot trace at all", async () => {
    const { w, handleAction } = await render({
      lowPower: false,
      auto: false,
      webgpu: false,
      native: { available: false },
    });
    const btn = w.get('[data-view-mode="pathtraced"]');
    await btn.trigger("click");
    expect([btn.attributes("aria-disabled"), btn.classes("is-disabled"), handleAction.mock.calls]).toEqual([
      "true",
      true,
      [],
    ]);
  });
});

describe("ViewportControls popover controls", () => {
  it("names the grid button by its reading and shows it pressed while its popover is open", async () => {
    const { w } = await render(TIER);
    const grid = w.get(".grid-btn");
    expect([grid.attributes("type"), grid.attributes("title"), grid.attributes("aria-pressed")]).toEqual([
      "button",
      "Grid and units",
      "false",
    ]);
    expect(grid.attributes("aria-label")).toBeUndefined();
    await grid.trigger("click");
    expect(grid.attributes("aria-pressed")).toBe("true");
    expect(document.querySelector(".vc-pop")?.textContent).toContain("Units");
  });

  it("turns the camera from the Views rows and buttons", async () => {
    const { w, handleAction, setStandardView } = await render(TIER);
    await w.get('[aria-label="Views"]').trigger("click");
    const rows = [...document.querySelectorAll<HTMLButtonElement>(".vc-pop .ui-list-row")];
    expect(rows.map((r) => [r.type, r.textContent?.trim()])).toEqual(
      ["Top", "Bottom", "Front", "Back", "Right", "Left"].map((l) => ["button", l]),
    );
    rows[2]!.click();
    byText(".vc-pop .btn", "Default View")!.click();
    byText(".vc-pop .btn", "Fit to Model")!.click();
    expect([setStandardView.mock.calls, handleAction.mock.calls]).toEqual([[["front"]], [["iso"], ["fit"]]]);
  });

  it("offers the matcap spheres as one radio group the arrows move through", async () => {
    setRenderPref("matcapStyle", "studio");
    const ui = useUiStore();
    ui.viewMode = "matcap";
    const { w } = await render(TIER);
    await w.get('[aria-label="Display"]').trigger("click");
    const group = document.querySelector<HTMLElement>(".vc-pop .matcap-swatches")!;
    const swatches = [...group.querySelectorAll<HTMLElement>(".matcap-swatch")];
    expect([group.getAttribute("role"), group.getAttribute("aria-label")]).toEqual(["radiogroup", "Matcap"]);
    expect(
      swatches.map((b) => [b.dataset.matcap, b.getAttribute("aria-label"), b.getAttribute("aria-checked")]),
    ).toEqual([
      ["studio", "studio", "true"],
      ["clay", "clay", "false"],
      ["metal", "metal", "false"],
      ["wax", "wax", "false"],
    ]);
    swatches[0]!.focus();
    swatches[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    expect(renderPrefs().matcapStyle).toBe("clay");
    swatches[3]!.click();
    expect(renderPrefs().matcapStyle).toBe("wax");
    setRenderPref("matcapStyle", "studio");
  });
});

describe("a view controls column taller than its room", () => {
  let fire: () => void = () => {};
  beforeEach(() => {
    const seen: (() => void)[] = [];
    fire = () => seen.forEach((cb) => cb());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          seen.push(cb);
        }
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function sized(w: Awaited<ReturnType<typeof render>>["w"], content: number, room: number) {
    const rail = w.get("#viewcontrols").element as HTMLElement;
    const list = w.get(".vc-scroll").element as HTMLElement;
    let top = 0;
    Object.defineProperty(rail.parentElement!, "clientHeight", { configurable: true, get: () => room });
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => content });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => Math.min(content, room) });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(content - Math.min(content, room), v));
      },
    });
    return list;
  }
  const state = (w: Awaited<ReturnType<typeof render>>["w"]) => ({
    scrolls: w.get("#viewcontrols").classes("scrolls"),
    cues: w.findAll(".vc-more").map((c) => [c.attributes("aria-label"), c.attributes("tabindex")]),
  });

  it("keeps its shadow room and shows no cue while every control fits", async () => {
    const { w } = await render(TIER);
    sized(w, 400, 600);
    fire();
    await nextTick();
    await nextTick();
    expect(state(w)).toEqual({ scrolls: false, cues: [] });
  });

  it("clips at the column and pages to the controls out of sight from cues outside the Tab walk", async () => {
    const { w } = await render(TIER);
    const list = sized(w, 700, 300);
    fire();
    await nextTick();
    await nextTick();
    const atTop = state(w);
    await w.get(".vc-more-down").trigger("click");
    const middle = { top: list.scrollTop, cues: state(w).cues.map((c) => c[0]) };
    await w.get(".vc-more-down").trigger("click");
    const atEnd = { top: list.scrollTop, cues: state(w).cues.map((c) => c[0]) };
    await w.get(".vc-more-up").trigger("click");
    expect({ atTop, middle, atEnd, back: list.scrollTop }).toEqual({
      atTop: { scrolls: true, cues: [["More view controls below", "-1"]] },
      middle: { top: 225, cues: ["More view controls above", "More view controls below"] },
      atEnd: { top: 400, cues: ["More view controls above"] },
      back: 175,
    });
  });

  it("measures again when a group appears", async () => {
    const { w } = await render(TIER);
    sized(w, 400, 600);
    fire();
    await nextTick();
    sized(w, 700, 600);
    useUiStore().lowPerformance = true;
    await flushPromises();
    expect(state(w)).toEqual({ scrolls: true, cues: [["More view controls below", "-1"]] });
  });

  it("brings a focused control into view past the cues", async () => {
    const seen: [string | null, unknown][] = [];
    Element.prototype.scrollIntoView = vi.fn(function (this: HTMLElement, arg: unknown) {
      seen.push([this.getAttribute("aria-label"), arg]);
    });
    try {
      const { w } = await render(TIER);
      (w.get('[aria-label="Snapping"]').element as HTMLElement).focus();
      expect(seen).toEqual([["Snapping", { block: "nearest" }]]);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
