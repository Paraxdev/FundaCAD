// The Potato mode switch in Preferences: right under Performance mode, and
// switching it on shows performance mode as on and locked without writing it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";

enableAutoUnmount(afterEach);

// The id is on the Checkbox's label, the native box is inside it.
const row = (id: string) => document.getElementById(id)!;
const input = (id: string) => row(id).querySelector("input")!;

describe("Potato mode in Preferences", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRenderPref("potatoMode", false);
    setRenderPref("performanceMode", false);
  });

  it("sits directly beneath the performance switch with its tooltip", () => {
    mount(PreferencesDialog, { attachTo: document.body });
    const perfHead = row("prefs-performance-mode").closest(".pref-head")!;
    const potatoHead = row("prefs-potato-mode").closest(".pref-head")!;
    expect(potatoHead.parentElement).toBe(perfHead.parentElement);
    // The performance hint, then the potato switch.
    expect(perfHead.nextElementSibling!.nextElementSibling).toBe(potatoHead);
    expect(potatoHead.querySelector(".pref-title")!.textContent).toBe("Potato mode");
    expect(potatoHead.getAttribute("title")).toBe("Lowest quality, for slow or virtual machines");
  });

  it("turns on performance mode with it and gives it back when turned off", async () => {
    mount(PreferencesDialog, { attachTo: document.body });
    const potato = input("prefs-potato-mode");
    potato.checked = true;
    potato.dispatchEvent(new Event("change"));
    await nextTick();
    expect(renderPrefs().potatoMode).toBe(true);
    expect(renderPrefs().performanceMode).toBe(false);
    expect(input("prefs-performance-mode").checked).toBe(true);
    expect(row("prefs-performance-mode").getAttribute("aria-disabled")).toBe("true");

    potato.checked = false;
    potato.dispatchEvent(new Event("change"));
    await nextTick();
    expect(renderPrefs().potatoMode).toBe(false);
    expect(input("prefs-performance-mode").checked).toBe(false);
    expect(row("prefs-performance-mode").hasAttribute("aria-disabled")).toBe(false);
  });

  it("refuses a click on performance mode while potato mode holds it on", async () => {
    setRenderPref("potatoMode", true);
    mount(PreferencesDialog, { attachTo: document.body });
    await nextTick();
    input("prefs-performance-mode").click();
    await nextTick();
    expect([renderPrefs().performanceMode, input("prefs-performance-mode").checked]).toEqual([false, true]);
  });
});
