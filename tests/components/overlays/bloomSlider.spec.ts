import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";

enableAutoUnmount(afterEach);

const slider = () => document.querySelector("#prefs-bloom input[type=range]") as HTMLInputElement;

async function drag(to: string) {
  slider().value = to;
  slider().dispatchEvent(new Event("input"));
  await nextTick();
}

describe("the Bloom slider in Preferences", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    setRenderPref("bloom", 0.4);
  });

  it("sets the bloom amount to where it is dragged in percent, a string from the DOM included", async () => {
    mount(PreferencesDialog, { attachTo: document.body });
    expect(slider().value).toBe("40");
    expect(slider().getAttribute("aria-valuetext")).toBe("40%");
    await drag("65");
    expect(renderPrefs().bloom).toBe(0.65);
    await drag("100");
    expect(renderPrefs().bloom).toBe(1);
    await drag("0");
    expect(renderPrefs().bloom).toBe(0);
    await drag("15");
    expect(renderPrefs().bloom).toBe(0.15);
    expect(slider().value).toBe("15");
    expect(slider().getAttribute("aria-valuetext")).toBe("15%");
  });
});
