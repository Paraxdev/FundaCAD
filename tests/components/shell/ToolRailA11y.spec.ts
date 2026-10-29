// The rail is one vertical toolbar inside the Tools landmark, its tools say pressed, its families say they open a
// dialog, and a key opens a family's flyout, takes focus into it and gives it back to the family on Escape.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, nextTick, ref, shallowRef } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { useRibbonStore } from "../../../src/stores/ribbon";
import { setInputModalityForTest } from "../../../src/ui/inputModality";

const state = vi.hoisted(() => ({ kind: "" }));

vi.mock("../../../src/composables/useSelectionOffers", () => ({
  useSelectionOffers: () => ({
    counts: shallowRef({}),
    kind: computed(() => state.kind),
    offers: computed(() => []),
    appOffers: computed(() => []),
    pluginGroups: computed(() => []),
    looks: computed(() => []),
    summary: computed(() => ""),
    readout: computed(() => ""),
    toolOwns: ref(false),
    run: () => {},
    look: () => {},
    clear: () => {},
    wake: () => {},
  }),
}));

vi.mock("../../../src/app/useDoc", () => ({
  useDocValue: () => computed(() => "Sketch 1"),
  useBuildValue: () => computed(() => false),
}));

import ToolRail from "../../../src/components/shell/ToolRail.vue";

enableAutoUnmount(afterEach);

const engine = {
  store: { onDocChange: () => () => {}, onBuild: () => () => {} },
  tools: { section: { active: false, picking: false }, measure: { active: false } },
  viewport: { selectedFaceSketchPlane: () => null, getSelectedBodies: () => [] },
  sketch: { active: false, constraintOptions: () => [] },
  handleAction: () => {},
  setStatus: () => {},
} as unknown as Engine;

function mountRail() {
  return mount(ToolRail, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
}

const flyout = () => document.querySelector<HTMLElement>(".rail-flyout");
const btn = (sel: string) => document.querySelector<HTMLButtonElement>(`#toolrail ${sel}`)!;
const key = (el: Element, k: string) =>
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
const settle = async () => {
  await nextTick();
  await nextTick();
};

describe("the tool rail for keyboard and screen reader users", () => {
  let acted: string[];
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    state.kind = "";
    acted = [];
    useRibbonStore().bind((a) => acted.push(a));
    setInputModalityForTest("keyboard");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setInputModalityForTest("pointer");
  });

  it("is one vertical toolbar named Tools with a single Tab stop that the arrows move", async () => {
    const w = mountRail();
    await settle();
    const bar = w.get('[role="toolbar"]').element;
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>("button")];
    const stops = buttons.filter((b) => b.tabIndex === 0).map((b) => b.dataset["action"]);
    buttons[0]!.focus();
    key(buttons[0]!, "ArrowDown");
    expect({
      nav: w.element.getAttribute("aria-label"),
      name: bar.getAttribute("aria-label"),
      orientation: bar.getAttribute("aria-orientation"),
      holdsFoot: !!bar.querySelector(".rail-foot"),
      stops,
      next: document.activeElement === buttons[1],
    }).toEqual({
      nav: "Tools",
      name: "Tools",
      orientation: "vertical",
      holdsFoot: true,
      stops: ["search"],
      next: true,
    });
  });

  it("says a category opens a dialog, opens it from a key into its first tool and returns focus on Escape", async () => {
    mountRail();
    await settle();
    const create = btn('[data-family="cat:CREATE"]');
    const before = {
      popup: create.getAttribute("aria-haspopup"),
      expanded: create.getAttribute("aria-expanded"),
      pressed: create.getAttribute("aria-pressed"),
    };
    create.focus();
    create.click();
    await settle();
    const card = flyout()!;
    const open = {
      role: card.getAttribute("role"),
      name: card.getAttribute("aria-label"),
      expanded: create.getAttribute("aria-expanded"),
      focusIn: card.contains(document.activeElement),
      first: document.activeElement === card.querySelector("button"),
      grid: card.querySelector('[role="toolbar"]')?.getAttribute("aria-label"),
    };
    key(document.activeElement!, "Escape");
    await settle();
    expect({ before, open, closed: !flyout(), back: document.activeElement === create }).toEqual({
      before: { popup: "dialog", expanded: "false", pressed: null },
      open: { role: "dialog", name: "Create", expanded: "true", focusIn: true, first: true, grid: "Create tools" },
      closed: true,
      back: true,
    });
  });

  it("says which tool in a category is on in the family name, and pressed on the tool", async () => {
    useRibbonStore().viewOn = { zebra: true };
    mountRail();
    await settle();
    const inspect = btn('[data-family="cat:INSPECT"]');
    inspect.click();
    await settle();
    const zebra = flyout()!.querySelector<HTMLElement>('[data-pick="zebra"]')!;
    const curvature = flyout()!.querySelector<HTMLElement>('[data-pick="curvature"]')!;
    const other = flyout()!.querySelector<HTMLElement>('[data-pick="measure"], [data-pick="interference"]');
    expect({
      name: inspect.getAttribute("aria-label"),
      title: inspect.getAttribute("title"),
      zebra: zebra.getAttribute("aria-pressed"),
      curvature: curvature.getAttribute("aria-pressed"),
      other: other?.getAttribute("aria-pressed") ?? null,
    }).toEqual({ name: "Inspect, Zebra on", title: "Inspect", zebra: "true", curvature: "false", other: null });
  });

  it("says pressed on sketch tools and opens a variants family from a key, which a pointer press still arms", async () => {
    const ribbon = useRibbonStore();
    ribbon.context = "sketch";
    ribbon.activeSketchTool = "line";
    mountRail();
    await settle();
    const line = btn('[data-action="line"]');
    const arc = btn('[data-action="arc"]');
    const rect = btn('[data-family="fam:rectangle"]');
    rect.click();
    await settle();
    const opened = {
      card: flyout()?.getAttribute("aria-label") ?? null,
      expanded: rect.getAttribute("aria-expanded"),
      focusIn: !!flyout()?.contains(document.activeElement),
    };
    if (flyout()) key(document.activeElement!, "Escape");
    await settle();
    setInputModalityForTest("pointer");
    rect.dispatchEvent(new PointerEvent("pointerdown", { button: 0, bubbles: true, pointerId: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { button: 0, bubbles: true, pointerId: 1 }));
    rect.dispatchEvent(new MouseEvent("click", { detail: 1, bubbles: true }));
    await settle();
    expect({
      line: line.getAttribute("aria-pressed"),
      arc: arc.getAttribute("aria-pressed"),
      popup: rect.getAttribute("aria-haspopup"),
      opened,
      pointer: { flyout: !!flyout(), acted },
    }).toEqual({
      line: "true",
      arc: "false",
      popup: "dialog",
      opened: { card: "Rectangle", expanded: "true", focusIn: true },
      pointer: { flyout: false, acted: ["rectangle"] },
    });
  });

  it("says pressed on the foot toggles", async () => {
    mountRail();
    await settle();
    const pressed = ["isolate", "section", "measure"].map((a) =>
      btn(`[data-action="${a}"]`).getAttribute("aria-pressed"),
    );
    expect(pressed).toEqual(["false", "false", "false"]);
  });
});
