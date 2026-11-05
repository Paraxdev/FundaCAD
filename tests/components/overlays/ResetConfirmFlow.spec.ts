// The real confirm over a page: Cancel holds the focus, Enter and Escape keep the values, the red Reset applies them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { defineComponent, h } from "vue";
import { createPinia, setActivePinia } from "pinia";
import ExperimentalSection from "../../../src/components/overlays/ExperimentalSection.vue";
import ModalHost from "../../../src/components/overlays/ModalHost.vue";
import { experimentalPrefs, resetExperimentalPrefs, setExperimentalPref } from "../../../src/ui/experimentalPrefs";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const settle = () => new Promise((r) => setTimeout(r, 20));
const press = async (k: string) => {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  await flushPromises();
  await settle();
};

async function open() {
  const Page = defineComponent({ render: () => h("div", [h(ExperimentalSection), h(ModalHost)]) });
  mount(Page, { attachTo: document.body });
  await settle();
  setExperimentalPref("bounces", 12);
  await flushPromises();
  const reset = $("[data-experimental-reset]");
  reset.focus();
  reset.click();
  await settle();
}

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
  resetExperimentalPrefs();
});

describe("Reset to defaults over a page", () => {
  it("opens with Cancel focused and the Reset choice painted red", async () => {
    await open();
    expect($(".ui-confirm").textContent).toContain("Reset the Path traced limits?");
    expect(document.activeElement?.textContent).toContain("Cancel");
    expect(
      [...document.querySelectorAll(".ui-confirm-choice")].map((b) => b.classList.contains("ui-confirm-danger")),
    ).toEqual([false, true]);
    expect(experimentalPrefs().bounces).toBe(12);
  });

  it("Enter on the focused Cancel and Escape both keep the value and close the question", async () => {
    await open();
    await press("Enter");
    expect(experimentalPrefs().bounces).toBe(12);
    expect(document.querySelector(".ui-confirm")).toBeNull();
    $("[data-experimental-reset]").click();
    await settle();
    expect(document.querySelector(".ui-confirm")).not.toBeNull();
    await press("Escape");
    expect(experimentalPrefs().bounces).toBe(12);
    expect(document.querySelector(".ui-confirm")).toBeNull();
    expect(document.activeElement).toBe($("[data-experimental-reset]"));
  });

  it("choosing Reset puts the value back", async () => {
    await open();
    document.querySelectorAll<HTMLElement>(".ui-confirm-choice")[1]!.click();
    await settle();
    expect(experimentalPrefs().bounces).not.toBe(12);
    expect(document.querySelector(".ui-confirm")).toBeNull();
  });
});
