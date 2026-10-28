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
