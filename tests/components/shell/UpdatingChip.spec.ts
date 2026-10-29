// The Updating chip: a spinner while motion runs, the static word alone when Animations is off.

import { afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import UpdatingChip from "../../../src/components/shell/UpdatingChip.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { setA11yPref } from "../../../src/ui/a11yPrefs";
import { setMotion } from "../../../src/ui/motion";

let show: ((on: boolean) => void) | null = null;
vi.mock("../../../src/app/staleModel", () => ({
  watchSlowBuild: (_store: unknown, fn: (on: boolean) => void) => {
    show = fn;
    return () => {
      show = null;
    };
  },
}));

enableAutoUnmount(afterEach);
afterEach(() => setA11yPref("animations", "system"));

async function mountShown() {
  const w = mount(UpdatingChip, { global: { provide: { [ENGINE as symbol]: { store: {} } } } });
  show?.(true);
  await nextTick();
  return w;
}

describe("the Updating chip", () => {
  it("spins while motion is on", async () => {
    setMotion(true);
    const w = await mountShown();
    expect(w.get('[data-testid="updating-chip"]').text()).toBe("Updating");
    expect(w.find(".updating-spin").exists()).toBe(true);
  });

  it("shows the word without a spinner while motion is off", async () => {
    setMotion(false);
    const w = await mountShown();
    expect(w.get('[data-testid="updating-chip"]').text()).toBe("Updating");
    expect(w.find(".updating-spin").exists()).toBe(false);
  });

  it("drops and restores the spinner when Animations changes while it shows", async () => {
    setMotion(true);
    const w = await mountShown();
    setMotion(false);
    await nextTick();
    expect(w.find(".updating-spin").exists()).toBe(false);
    setMotion(true);
    await nextTick();
    expect(w.find(".updating-spin").exists()).toBe(true);
  });
});
