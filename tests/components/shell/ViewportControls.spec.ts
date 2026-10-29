import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ref } from "vue";
import ViewportControls from "../../../src/components/shell/ViewportControls.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { resetPathTracedOverride, type RenderTier } from "../../../src/ui/viewMode";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";
import { useUiStore } from "../../../src/stores/ui";
import { setInputModalityForTest } from "../../../src/ui/inputModality";

enableAutoUnmount(afterEach);

beforeEach(() => {
  setActivePinia(createPinia());
  resetPathTracedOverride();
  setInputModalityForTest("pointer");
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
    store: { buildState: {}, fileName: "Untitled", dirty: false, document: {} },
    bridge: { buildVersion: ref(0), metaVersion: ref(0), docVersion: ref(0) },
  } as unknown as Engine;
  const w = mount(ViewportControls, {
    global: { provide: { [ENGINE as symbol]: engine }, stubs: { VersionsPanel: true } },
    attachTo: document.body,
  });
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
