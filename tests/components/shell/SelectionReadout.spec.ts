import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref, shallowRef } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";

const sel = vi.hoisted(() => ({
  readout: null as unknown as { value: string },
  speech: null as unknown as { value: { text: string; verbose?: boolean } | null },
  toolOwns: null as unknown as { value: boolean },
  lit: null as unknown as { value: boolean },
}));
vi.mock("../../../src/ui/announce", () => ({ announce: vi.fn() }));
vi.mock("../../../src/app/engineKey", () => ({ useEngine: () => ({}) }));
vi.mock("../../../src/composables/useSelectionOffers", () => ({ useSelectionOffers: () => sel }));

import SelectionReadout from "../../../src/components/shell/SelectionReadout.vue";
import { announce } from "../../../src/ui/announce";

enableAutoUnmount(afterEach);

describe("the selection readout", () => {
  beforeEach(() => {
    vi.mocked(announce).mockClear();
    sel.readout = ref("");
    sel.speech = shallowRef(null);
    sel.toolOwns = ref(false);
    sel.lit = ref(false);
  });

  it("shows the symbols and speaks the words", async () => {
    const w = mount(SelectionReadout);
    sel.readout.value = "1 face · hole · ⌀50 mm";
    sel.speech.value = { text: "Hole 7, diameter 50 millimetres, Body1" };
    await nextTick();
    expect(w.get("[data-testid=selection-readout]").text()).toBe("1 face · hole · ⌀50 mm");
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["Hole 7, diameter 50 millimetres, Body1", "polite", { key: "selection", delay: 250 }],
    ]);
  });

  it("speaks each change under one debounced key, the same words twice included", async () => {
    mount(SelectionReadout);
    sel.speech.value = { text: "Face 4 added, 2 selected" };
    await nextTick();
    sel.speech.value = { text: "Face 4 added, 2 selected" };
    await nextTick();
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["Face 4 added, 2 selected", "polite", { key: "selection", delay: 250 }],
      ["Face 4 added, 2 selected", "polite", { key: "selection", delay: 250 }],
    ]);
  });

  it("marks what is only worth saying at Verbose", async () => {
    mount(SelectionReadout);
    sel.speech.value = { text: "Nothing selected", verbose: true };
    await nextTick();
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["Nothing selected", "polite", { key: "selection", delay: 250, verbose: true }],
    ]);
  });

  it("does not speak again when only the text on screen changes", async () => {
    mount(SelectionReadout);
    sel.speech.value = { text: "Flat face 4" };
    await nextTick();
    sel.readout.value = "1 face · flat · 60 by 40 mm";
    await nextTick();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("shows and says nothing while a tool owns the screen, its prompt speaks instead", async () => {
    const w = mount(SelectionReadout);
    sel.toolOwns.value = true;
    sel.readout.value = "1 face";
    sel.speech.value = { text: "Flat face 4" };
    await nextTick();
    expect(w.find("[data-testid=selection-readout]").exists()).toBe(false);
    expect(announce).not.toHaveBeenCalled();
  });

  it("shows the lit row's readout under a tool and drops it with the light, still saying nothing", async () => {
    const w = mount(SelectionReadout);
    sel.toolOwns.value = true;
    sel.readout.value = "Flat face 3 · 41.5 by 22 mm";
    sel.speech.value = { text: "Flat face 3" };
    await nextTick();
    expect(w.find("[data-testid=selection-readout]").exists()).toBe(false);
    sel.lit.value = true;
    await nextTick();
    expect(w.get("[data-testid=selection-readout]").text()).toBe("Flat face 3 · 41.5 by 22 mm");
    sel.lit.value = false;
    await nextTick();
    expect(w.find("[data-testid=selection-readout]").exists()).toBe(false);
    expect(announce).not.toHaveBeenCalled();
  });

  it("keeps a lit row with no words off the screen, and a lit row without a tool still shows", async () => {
    const w = mount(SelectionReadout);
    sel.toolOwns.value = true;
    sel.lit.value = true;
    await nextTick();
    expect(w.find("[data-testid=selection-readout]").exists()).toBe(false);
    sel.toolOwns.value = false;
    sel.readout.value = "Edge 7 · 18.2 mm";
    await nextTick();
    expect(w.get("[data-testid=selection-readout]").text()).toBe("Edge 7 · 18.2 mm");
  });
});
