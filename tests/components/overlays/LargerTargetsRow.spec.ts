import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import LargerTargetsRow from "../../../src/components/overlays/LargerTargetsRow.vue";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { a11yPrefs, resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";
import { setLargeTargets } from "../../../src/ui/targets";

enableAutoUnmount(afterEach);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const box = () => $<HTMLInputElement>("#prefs-larger-targets input[type=checkbox]");

beforeEach(() => {
  setActivePinia(createPinia());
  resetA11yPrefs();
});

describe("Larger click targets row", () => {
  it("names its box Larger click targets and describes it with the hint", () => {
    mount(LargerTargetsRow, { attachTo: document.body });
    expect($("#prefs-larger-targets").closest(".pref-card")).not.toBeNull();
    expect(box().closest("label")?.textContent?.trim()).toBe("Larger click targets");
    const hint = box().getAttribute("aria-describedby");
    expect(hint).toBe("prefs-larger-targets-hint");
    expect($(`#${hint}`).textContent).toContain("32");
  });

  it("follows the pref, from a stored choice and from a change made elsewhere", async () => {
    setA11yPref("targets", "large");
    mount(LargerTargetsRow, { attachTo: document.body });
    expect(box().checked).toBe(true);
    setLargeTargets(false);
    await flushPromises();
    expect(box().checked).toBe(false);
  });

  it("turns Larger click targets on and off and puts data-targets on the page root", async () => {
    mount(LargerTargetsRow, { attachTo: document.body });
    box().click();
    await flushPromises();
    expect([a11yPrefs().targets, document.documentElement.dataset.targets, box().checked]).toEqual([
      "large",
      "large",
      true,
    ]);
    box().click();
    await flushPromises();
    expect([a11yPrefs().targets, document.documentElement.dataset.targets]).toEqual(["default", undefined]);
  });
});

describe("Larger click targets in Preferences", () => {
  async function access() {
    mount(PreferencesDialog, { attachTo: document.body });
    await new Promise((r) => setTimeout(r, 2));
    await flushPromises();
    $('.prefs-nav-btn[data-category="access"]').click();
    await flushPromises();
  }

  it("sits in Keyboard and pointer after Hover delay", async () => {
    await access();
    const group = $('[role=group][aria-labelledby="prefs-a11y-input"]');
    const cards = [...group.querySelectorAll(".pref-card")];
    expect(cards.map((c) => (c.querySelector("[id]") as HTMLElement).id)).toEqual([
      "prefs-hover-dwell",
      "prefs-larger-targets",
    ]);
  });

  it("lets Reset to defaults run while it is on, and Reset turns it off", async () => {
    await access();
    const reset = $("[data-a11y-reset]");
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    box().click();
    await flushPromises();
    expect(reset.getAttribute("aria-disabled")).toBeNull();
    reset.click();
    await flushPromises();
    expect([a11yPrefs().targets, box().checked, document.documentElement.dataset.targets]).toEqual([
      "default",
      false,
      undefined,
    ]);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
  });
});
