import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";

const sel = vi.hoisted(() => ({
  readout: null as unknown as { value: string | null },
  toolOwns: null as unknown as { value: boolean },
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
    sel.readout = ref<string | null>(null);
    sel.toolOwns = ref(false);
  });

  it("speaks each settled selection under one debounced key", async () => {
    mount(SelectionReadout);
    sel.readout.value = "1 face · ⌀50 mm";
    await nextTick();
    sel.readout.value = "2 faces · 680 mm²";
    await nextTick();
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["1 face · ⌀50 mm", "polite", { key: "selection", delay: 250 }],
      ["2 faces · 680 mm²", "polite", { key: "selection", delay: 250 }],
    ]);
  });

  it("says Nothing selected only at Verbose when the selection clears", async () => {
    mount(SelectionReadout);
    sel.readout.value = "1 edge";
    await nextTick();
    sel.readout.value = "";
    await nextTick();
    expect(vi.mocked(announce).mock.calls[1]).toEqual([
      "Nothing selected",
      "polite",
      { key: "selection", delay: 250, verbose: true },
    ]);
  });

  it("stays quiet while a tool owns the screen, its prompt speaks instead", async () => {
    mount(SelectionReadout);
    sel.toolOwns.value = true;
    sel.readout.value = "1 face";
    await nextTick();
    sel.readout.value = "";
    await nextTick();
    expect(announce).not.toHaveBeenCalled();
  });
});
