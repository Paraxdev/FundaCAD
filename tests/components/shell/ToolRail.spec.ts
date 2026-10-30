// A plugin's tools fold under a group header in the rail. The header is a RailButton, so it also carries .rail-btn,
// and what is pinned here is that it still reads and folds as a header: its name, its tool count tip, aria-expanded
// and the children it hides.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computed, ref, shallowRef } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";

const offers = vi.hoisted(() => ({
  groups: [
    {
      pluginId: "gears",
      name: "Gears",
      offers: [
        { tool: "gears.spur", label: "Spur gear", iconName: "gear", hint: "", pluginId: "gears" },
        { tool: "gears.rack", label: "Rack", iconName: "gear", hint: "", pluginId: "gears" },
      ],
    },
  ],
}));

vi.mock("../../../src/composables/useSelectionOffers", () => ({
  useSelectionOffers: () => ({
    counts: shallowRef({ body: 1 }),
    kind: computed(() => "body"),
    offers: computed(() => offers.groups.flatMap((g) => g.offers)),
    appOffers: computed(() => []),
    pluginGroups: computed(() => offers.groups),
    looks: computed(() => []),
    summary: computed(() => "1 body"),
    readout: computed(() => ""),
    toolOwns: ref(false),
    run: () => {},
    look: () => {},
    clear: () => {},
    wake: () => {},
  }),
}));

vi.mock("../../../src/app/useDoc", () => ({
  useDocValue: () => computed(() => "New sketch"),
  useBuildValue: () => computed(() => false),
}));

import ToolRail from "../../../src/components/shell/ToolRail.vue";

enableAutoUnmount(afterEach);

const engine = {
  store: { onDocChange: () => () => {}, onBuild: () => () => {} },
  tools: { section: { active: false, picking: false }, measure: { active: false } },
  viewport: { selectedFaceSketchPlane: () => null, getSelectedBodies: () => [] },
  handleAction: () => {},
  setStatus: () => {},
} as unknown as Engine;

function mountRail() {
  return mount(ToolRail, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
}

const header = (w: ReturnType<typeof mountRail>) => w.get<HTMLButtonElement>('[data-group="gears"]').element;
const children = (w: ReturnType<typeof mountRail>) => w.findAll(".rail-child").map((c) => c.attributes("data-action"));

describe("a plugin group header in the tool rail", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the plugin, tips its tool count and starts open with its tools below", () => {
    const w = mountRail();
    const h = header(w);
    expect({
      classes: [...h.classList].sort(),
      label: h.getAttribute("aria-label"),
      title: h.getAttribute("title"),
      expanded: h.getAttribute("aria-expanded"),
      text: h.textContent?.trim(),
      children: children(w),
    }).toEqual({
      classes: ["rail-btn", "rail-group"],
      label: "Gears",
      title: "Gears · 2 tools",
      expanded: "true",
      text: "Gears",
      children: ["offer:gears.spur", "offer:gears.rack"],
    });
  });

  it("folds its tools away on a click and brings them back on the next", async () => {
    const w = mountRail();
    await w.get('[data-group="gears"]').trigger("click");
    const folded = {
      classes: [...header(w).classList].sort(),
      expanded: header(w).getAttribute("aria-expanded"),
      children: children(w),
    };
    await w.get('[data-group="gears"]').trigger("click");
    const open = {
      classes: [...header(w).classList].sort(),
      expanded: header(w).getAttribute("aria-expanded"),
      children: children(w),
    };
    expect({ folded, open }).toEqual({
      folded: { classes: ["collapsed", "rail-btn", "rail-group"], expanded: "false", children: [] },
      open: {
        classes: ["rail-btn", "rail-group"],
        expanded: "true",
        children: ["offer:gears.spur", "offer:gears.rack"],
      },
    });
  });
});

describe("a tool rail taller than its room", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function overflow(list: HTMLElement, scrollHeight: number, clientHeight: number) {
    let top = 0;
    Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => scrollHeight });
    Object.defineProperty(list, "clientHeight", { configurable: true, get: () => clientHeight });
    Object.defineProperty(list, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(scrollHeight - clientHeight, v));
      },
    });
  }
  const cues = (w: ReturnType<typeof mountRail>) =>
    w.findAll(".rail-more").map((c) => ({
      label: c.attributes("aria-label"),
      tabindex: c.attributes("tabindex"),
    }));

  it("shows no cue while every tool fits", async () => {
    const w = mountRail();
    const list = w.get(".rail-list").element as HTMLElement;
    overflow(list, 300, 300);
    await w.get(".rail-list").trigger("scroll");
    const rail = w.get("#toolrail");
    expect({ cues: cues(w), above: rail.classes("more-above"), below: rail.classes("more-below") }).toEqual({
      cues: [],
      above: false,
      below: false,
    });
  });

  it("cues the tools scrolled out of sight and pages to them on a click, outside the Tab walk", async () => {
    const w = mountRail();
    const list = w.get(".rail-list").element as HTMLElement;
    overflow(list, 500, 200);
    await w.get(".rail-list").trigger("scroll");
    const atTop = { cues: cues(w), rail: w.get("#toolrail").classes("more-below") };
    await w.get(".rail-more-down").trigger("click");
    const middle = { top: list.scrollTop, cues: cues(w).map((c) => c.label) };
    await w.get(".rail-more-down").trigger("click");
    const atEnd = { top: list.scrollTop, cues: cues(w).map((c) => c.label) };
    await w.get(".rail-more-up").trigger("click");
    expect({ atTop, middle, atEnd, back: list.scrollTop }).toEqual({
      atTop: { cues: [{ label: "More tools below", tabindex: "-1" }], rail: true },
      middle: { top: 150, cues: ["More tools above", "More tools below"] },
      atEnd: { top: 300, cues: ["More tools above"] },
      back: 150,
    });
  });

  it("brings a focused tool into view past the cues", () => {
    const seen: [string | null, unknown][] = [];
    const scroll = vi.fn(function (this: HTMLElement, arg: unknown) {
      seen.push([this.getAttribute("data-action"), arg]);
    });
    Element.prototype.scrollIntoView = scroll;
    try {
      const w = mountRail();
      (w.get('[data-action="search"]').element as HTMLElement).focus();
      expect(seen).toEqual([["search", { block: "nearest" }]]);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});
