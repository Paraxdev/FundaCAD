// The mesh and run area of the Stress setup: the one button a finer answer brings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import StressSetupStep from "../../../src/components/overlays/StressSetupStep.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { usePanelsStore } from "../../../src/stores/panels";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));

async function mounted() {
  const runStress = vi.fn();
  const engine = { ui: { panels: { runStress } } } as unknown as Engine;
  const store = usePanelsStore();
  store.showStress("b1");
  const w = mount(StressSetupStep, {
    props: { setup: store.stress!.setup, bodies: [{ id: "b1", name: "Plate" }] },
    global: { provide: { [ENGINE as symbol]: engine } },
    attachTo: document.body,
  });
  await flushPromises();
  return { w, store, runStress };
}

function refused(store: ReturnType<typeof usePanelsStore>, seconds: number | null) {
  store.stressStarted();
  store.stressFinished({
    error: "This part needs a finer mesh.",
    ...(seconds === null ? {} : { finer: { elements: 90000, seconds } }),
  });
}

const button = (w: Awaited<ReturnType<typeof mounted>>["w"]) => w.find(".stress-finer");

describe("the finer answer in the Stress setup", () => {
  it("shows one button with the time, and it runs once with finer detail", async () => {
    const { w, store, runStress } = await mounted();
    refused(store, 118);
    await flushPromises();
    expect(button(w).text()).toBe("Run with finer detail (about 2 min)");
    await button(w).trigger("click");
    expect(runStress).toHaveBeenCalledTimes(1);
    expect(runStress).toHaveBeenCalledWith(true);
  });

  it("says one minute for a short run", async () => {
    const { w, store } = await mounted();
    refused(store, 12);
    await flushPromises();
    expect(button(w).text()).toBe("Run with finer detail (about 1 min)");
  });

  it("shows no button for an error without the answer", async () => {
    const { w, store } = await mounted();
    refused(store, null);
    await flushPromises();
    expect(w.find(".stress-error").exists()).toBe(true);
    expect(button(w).exists()).toBe(false);
  });

  it("drops the button when the setup is edited, its time was for the setup that ran", async () => {
    const { w, store } = await mounted();
    refused(store, 118);
    await flushPromises();
    store.stress!.setup.gravity.on = !store.stress!.setup.gravity.on;
    await flushPromises();
    expect(button(w).exists()).toBe(false);
  });
});

describe("Mesh detail in More options", () => {
  it("offers Coarse, Standard and Fine with no size box, and Standard to begin with", async () => {
    const { w, store } = await mounted();
    const detail = w.find(".stress-detail");
    expect(detail.attributes("aria-label")).toBe("Mesh detail, Standard");
    expect(detail.text()).toBe("Standard");
    expect(w.find(".stress-size").exists()).toBe(false);
    expect(w.find(".stress-more-body").text()).not.toMatch(/size|smaller|larger/i);
    await detail.trigger("click");
    await flushPromises();
    const options = [...document.querySelectorAll('[role="option"]')];
    expect(options.map((o) => o.textContent?.trim())).toEqual(["Coarse", "Standard", "Fine"]);
    (options[2] as HTMLElement).click();
    await flushPromises();
    expect(store.stress!.setup.refine).toBe("fine");
    expect(detail.text()).toBe("Fine");
  });

  it("stays shut on Standard, and opens by itself when a study has another detail", async () => {
    const standard = await mounted();
    await flushPromises();
    expect(standard.w.find(".stress-more").attributes("aria-expanded")).toBe("false");
    standard.w.unmount();
    const store = usePanelsStore();
    store.stress!.setup.refine = "off";
    const again = mount(StressSetupStep, {
      props: { setup: store.stress!.setup, bodies: [{ id: "b1", name: "Plate" }] },
      global: { provide: { [ENGINE as symbol]: { ui: { panels: { runStress: vi.fn() } } } as unknown as Engine } },
      attachTo: document.body,
    });
    await flushPromises();
    expect(again.find(".stress-more").attributes("aria-expanded")).toBe("true");
  });
});
