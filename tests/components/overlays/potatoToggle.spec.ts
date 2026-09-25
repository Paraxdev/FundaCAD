// The Potato mode switch in Preferences: right under Performance mode, and
// switching it on shows performance mode as on and locked without writing it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";

enableAutoUnmount(afterEach);

const input = (id: string) => document.getElementById(id) as HTMLInputElement;

describe("Potato mode in Preferences", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRenderPref("potatoMode", false);
    setRenderPref("performanceMode", false);
  });

  it("sits directly beneath the performance switch with its tooltip", () => {
    mount(PreferencesDialog, { attachTo: document.body });
    const perfHead = input("prefs-performance-mode").closest(".pref-head")!;
    const potatoHead = input("prefs-potato-mode").closest(".pref-head")!;
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
    expect(input("prefs-performance-mode").disabled).toBe(true);

    potato.checked = false;
    potato.dispatchEvent(new Event("change"));
    await nextTick();
    expect(renderPrefs().potatoMode).toBe(false);
    expect(input("prefs-performance-mode").checked).toBe(false);
    expect(input("prefs-performance-mode").disabled).toBe(false);
  });
});
