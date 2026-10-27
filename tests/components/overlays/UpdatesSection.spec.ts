import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const h = vi.hoisted(() => ({ supported: true }));
vi.mock("../../../src/ui/updates", () => ({ updatesSupported: async () => h.supported }));

import UpdatesSection from "../../../src/components/overlays/UpdatesSection.vue";
import { autoUpdateCheck, setAutoUpdateCheck, setUpdatePeriod, updatePeriod } from "../../../src/ui/updatePrefs";

enableAutoUnmount(afterEach);

async function open() {
  const w = mount(UpdatesSection, { attachTo: document.body });
  await flushPromises();
  return w;
}

beforeEach(() => {
  h.supported = true;
  setAutoUpdateCheck(true);
  setUpdatePeriod("daily");
});

describe("Updates in Preferences", () => {
  it("shows the switch on and the period Daily by default", async () => {
    const w = await open();
    const sw = w.get("#prefs-update-auto").element as HTMLInputElement;
    const period = w.get("#prefs-update-period");
    expect([sw.checked, period.text(), period.attributes("disabled")]).toEqual([true, "Daily", undefined]);
  });

  it("writes the switch and disables the period while it is off", async () => {
    const w = await open();
    await w.get("#prefs-update-auto").setValue(false);
    expect([autoUpdateCheck(), w.get("#prefs-update-period").attributes("aria-disabled")]).toEqual([false, "true"]);
    await w.get("#prefs-update-auto").setValue(true);
    expect([autoUpdateCheck(), w.get("#prefs-update-period").attributes("aria-disabled")]).toEqual([true, undefined]);
  });

  it("follows a period set elsewhere", async () => {
    const w = await open();
    setUpdatePeriod("launch");
    await flushPromises();
    expect([updatePeriod(), w.get("#prefs-update-period").text()]).toEqual(["launch", "Every launch"]);
  });

  it("says where updates come from on an install that cannot update itself, with no controls", async () => {
    h.supported = false;
    const w = await open();
    expect([
      w.get("[data-updates-unsupported]").text(),
      w.find("#prefs-update-auto").exists(),
      w.find("#prefs-update-period").exists(),
    ]).toEqual([
      "This install updates through its package manager, the GitHub releases page or the SourceForge mirror.",
      false,
      false,
    ]);
  });
});
