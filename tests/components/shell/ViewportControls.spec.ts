import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick, ref } from "vue";
import ViewportControls from "../../../src/components/shell/ViewportControls.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { PATH_TRACING_OFF, resetPathTracedOverride, type RenderTier } from "../../../src/ui/viewMode";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";
import { useUiStore } from "../../../src/stores/ui";
import { setInputModalityForTest } from "../../../src/ui/inputModality";
import { setMacForTest } from "../../../src/input/platform";

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetPathTracedOverride();
  setInputModalityForTest("pointer");
});

async function render(renderTier: RenderTier, viewportExtra: Record<string, unknown> = {}) {
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
      ...viewportExtra,
    },
    store: { buildState: {}, fileName: "Untitled", dirty: false, document: {} },
    bridge: { buildVersion: ref(0), metaVersion: ref(0), docVersion: ref(0) },
  } as unknown as Engine;
  const w = mount(ViewportControls, {
    global: { provide: { [ENGINE as symbol]: engine }, stubs: { VersionsPanel: true } },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return { w, handleAction, setStandardView, engine };
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

  it("keeps its name while blocked and gives the reason as its tooltip and description", async () => {
    const { w } = await render({ lowPower: true, auto: false, webgpu: true });
    const btn = w.get('[data-view-mode="pathtraced"]');
    const why = document.getElementById(btn.attributes("aria-describedby") ?? "")?.textContent;
    expect([btn.attributes("aria-label"), btn.attributes("title"), why]).toEqual([
      "Path traced (Z)",
      PATH_TRACING_OFF,
      PATH_TRACING_OFF,
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
  it("names the grid button by its reading and shows it expanded while its popover is open", async () => {
    const { w } = await render(TIER);
    const grid = w.get(".grid-btn");
    const state = () => [grid.attributes("aria-haspopup"), grid.attributes("aria-expanded"), grid.classes("is-on")];
    expect([grid.attributes("type"), grid.attributes("title"), grid.attributes("aria-pressed")]).toEqual([
      "button",
      "Grid and units",
      undefined,
    ]);
    expect(grid.attributes("aria-label")).toBeUndefined();
    expect(state()).toEqual(["dialog", "false", false]);
    await grid.trigger("click");
    expect(state()).toEqual(["dialog", "true", true]);
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

  it("ties the Views and Appearance tabs to the page each one shows", async () => {
    const { w } = await render(TIER);
    await w.get('[aria-label="Views"]').trigger("click");
    for (const [t, text] of [
      ["views", "Default View"],
      ["appearance", "Projection"],
    ] as const) {
      const tab = document.querySelector<HTMLElement>(`.vc-pop [role=tab][data-tab="${t}"]`)!;
      tab.click();
      await nextTick();
      const page = document.getElementById(tab.getAttribute("aria-controls") ?? "");
      expect([page?.getAttribute("role"), page?.getAttribute("aria-labelledby"), page?.textContent]).toEqual([
        "tabpanel",
        tab.id,
        expect.stringContaining(text),
      ]);
    }
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

describe("ViewportControls popover openers", () => {
  const card = () => document.querySelector<HTMLElement>(".float-popover");
  const settle = async () => {
    await flushPromises();
    await new Promise((r) => setTimeout(r, 5));
  };
  const OPENERS: [string, string][] = [
    ['[aria-label="Snapping"]', "Snapping"],
    [".grid-btn", "Grid and units"],
    ['[aria-label="Views"]', "Views"],
    ['[aria-label="Display"]', "Display"],
    ['[aria-label="Versions"]', "Versions"],
    ['[aria-label="Low performance"]', "Low performance"],
  ];

  it("says each opener opens a dialog, expanded while its card is open, and names the card like the opener", async () => {
    useUiStore().lowPerformance = true;
    const { w } = await render(TIER);
    const seen: unknown[] = [];
    for (const [sel, name] of OPENERS) {
      const btn = w.get(sel);
      const before = [btn.attributes("aria-haspopup"), btn.attributes("aria-expanded"), btn.attributes("aria-pressed")];
      await btn.trigger("click");
      await settle();
      seen.push([
        name,
        before,
        btn.attributes("aria-expanded"),
        card()?.getAttribute("role"),
        card()?.getAttribute("aria-label"),
      ]);
      await btn.trigger("click");
      await settle();
    }
    expect(seen).toEqual(OPENERS.map(([, name]) => [name, ["dialog", "false", undefined], "true", "dialog", name]));
  });

  it("opened by a key, a card takes focus on its first control and Escape gives it back to the opener", async () => {
    const { w } = await render(TIER);
    const snap = w.get<HTMLElement>('[aria-label="Snapping"]').element;
    snap.focus();
    setInputModalityForTest("keyboard");
    snap.click();
    await settle();
    const inCard = !!card()?.contains(document.activeElement);
    document.activeElement!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await settle();
    expect([inCard, card(), document.activeElement === snap, snap.getAttribute("aria-expanded")]).toEqual([
      true,
      null,
      true,
      "false",
    ]);
  });

  it("opened by a click, a card leaves focus where it was", async () => {
    const { w } = await render(TIER);
    w.get('[aria-label="Views"]').element.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    await settle();
    expect([card()?.getAttribute("aria-label"), card()?.contains(document.activeElement)]).toEqual(["Views", false]);
  });
});

async function press(key: string) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(e);
  await flushPromises();
}
const focusedName = () => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent;

describe("ViewportControls View mode and toolbar", () => {
  it("shows View mode as one radiogroup whose arrows only move focus, a click picks", async () => {
    const { w, handleAction } = await render(TIER);
    const group = w.get('[role="radiogroup"][aria-label="View mode"]');
    const radios = group.findAll('[role="radio"]');
    expect(
      radios.map((r) => [r.attributes("data-view-mode"), r.attributes("aria-checked"), r.attributes("tabindex")]),
    ).toEqual([
      ["matcap", "false", "-1"],
      ["realtime", "true", "0"],
      ["pathtraced", "false", "-1"],
    ]);
    expect(radios.map((r) => r.attributes("aria-pressed"))).toEqual([undefined, undefined, undefined]);
    (radios[1]!.element as HTMLElement).focus();
    await press("ArrowDown");
    expect([focusedName(), handleAction.mock.calls]).toEqual(["Path traced (Z)", []]);
    await radios[2]!.trigger("click");
    expect(handleAction.mock.calls).toEqual([["viewmode-pathtraced"]]);
  });

  it("makes the controls column one vertical toolbar whose arrows step over View mode", async () => {
    const { w } = await render(TIER);
    const bar = w.get('[role="toolbar"]');
    expect([bar.attributes("aria-label"), bar.attributes("aria-orientation"), bar.element.parentElement?.id]).toEqual([
      "View controls",
      "vertical",
      "viewcontrols",
    ]);
    const own = bar.findAll("button").filter((b) => !b.element.closest('[role="radiogroup"]'));
    expect(own.map((b) => b.attributes("tabindex")).filter((t) => t === "0")).toEqual(["0"]);
    (w.get('[aria-label="Reset camera"]').element as HTMLElement).focus();
    await press("ArrowDown");
    expect(focusedName()).toBe("Realtime (Z)");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(focusedName()).toBe("Display");
    await press("ArrowUp");
    expect(focusedName()).toBe("Realtime (Z)");
  });
});

describe("ViewportControls History button", () => {
  afterEach(() => setMacForTest(null));

  it.each([
    [false, "History (Ctrl+Alt+H)", "Control+Alt+H Control+Shift+2"],
    [true, "History (⌘+Shift+2)", "Meta+Shift+2"],
  ])("on macOS %s is named History and announces every chord of the platform", async (mac, title, keys) => {
    setMacForTest(mac);
    const { w } = await render(TIER);
    const btn = w.get('button[aria-label="History"]');
    expect([btn.attributes("title"), btn.attributes("aria-keyshortcuts")]).toEqual([title, keys]);
  });
});

describe("ViewportControls zebra options", () => {
  const zebraControls = () => [
    document.querySelector('.vc-pop [data-testid="zebra-direction"]'),
    document.querySelector('.vc-pop [data-testid="zebra-width"]'),
  ];

  it("shows the stripe direction and width only while Zebra is on", async () => {
    const { w, handleAction, engine } = await render(TIER, { zebraOn: false });
    handleAction.mockImplementation((a: string) => {
      if (a === "zebra") (engine.viewport as { zebraOn: boolean }).zebraOn = true;
    });
    await w.get('[aria-label="Display"]').trigger("click");
    expect(zebraControls()).toEqual([null, null]);
    document.querySelector<HTMLElement>('.vc-pop [role="switch"][aria-label="Zebra"]')!.click();
    await nextTick();
    expect(handleAction).toHaveBeenCalledWith("zebra");
    expect(zebraControls().every((el) => el !== null)).toBe(true);
  });

  it("reads and writes the remembered direction and width", async () => {
    setRenderPref("zebraDirection", "horizontal");
    setRenderPref("zebraWidth", 3);
    const { w } = await render(TIER, { zebraOn: true });
    await w.get('[aria-label="Display"]').trigger("click");
    const group = document.querySelector<HTMLElement>('.vc-pop [data-testid="zebra-direction"]')!;
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect([group.getAttribute("role"), group.getAttribute("aria-label")]).toEqual(["radiogroup", "Stripe direction"]);
    expect(radios.map((b) => [b.textContent?.trim(), b.getAttribute("aria-checked")])).toEqual([
      ["Horizontal", "true"],
      ["Vertical", "false"],
    ]);
    radios[1]!.click();
    expect(renderPrefs().zebraDirection).toBe("vertical");

    const range = document.querySelector<HTMLInputElement>('.vc-pop [data-testid="zebra-width"] input[type=range]')!;
    const name = document.getElementById(range.getAttribute("aria-labelledby")!)?.textContent;
    expect([range.min, range.max, range.step, range.value, name]).toEqual(["1", "5", "1", "3", "Stripe width"]);
    range.value = "5";
    range.dispatchEvent(new Event("input", { bubbles: true }));
    range.dispatchEvent(new Event("change", { bubbles: true }));
    expect(renderPrefs().zebraWidth).toBe(5);

    setRenderPref("zebraWidth", 2);
    setRenderPref("zebraDirection", "horizontal");
    await nextTick();
    expect(range.value).toBe("2");
    expect(radios.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    setRenderPref("zebraWidth", 3);
  });
});
