import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import NoticeTimeRow from "../../../src/components/overlays/NoticeTimeRow.vue";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { a11yPrefs, resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";

vi.mock("../../../src/ui/choice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/choice")>()),
  confirmDanger: async () => true,
}));

enableAutoUnmount(afterEach);

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const radios = () => [...document.querySelectorAll<HTMLElement>("#prefs-notice-time [role=radio]")];
const state = () => radios().map((r) => [r.textContent?.trim(), r.getAttribute("aria-checked")]);

beforeEach(() => {
  setActivePinia(createPinia());
  resetA11yPrefs();
});

describe("Notification time row", () => {
  it("offers Normal, Longer and Until dismissed with Normal pressed, described by the hint", () => {
    mount(NoticeTimeRow, { attachTo: document.body });
    expect(state()).toEqual([
      ["Normal", "true"],
      ["Longer", "false"],
      ["Until dismissed", "false"],
    ]);
    expect($("#prefs-notice-time").closest(".pref-card")).not.toBeNull();
    const hint = $("#prefs-notice-time").getAttribute("aria-describedby");
    expect(hint).toBe("prefs-notice-time-hint");
    expect($(`#${hint}`).textContent).toContain("15 seconds");
  });

  it("picking Longer then Until dismissed sets the pref", async () => {
    mount(NoticeTimeRow, { attachTo: document.body });
    radios()[1]!.click();
    await flushPromises();
    expect([a11yPrefs().noticeTime, state()[1]]).toEqual(["longer", ["Longer", "true"]]);
    radios()[2]!.click();
    await flushPromises();
    expect([a11yPrefs().noticeTime, state()[2]]).toEqual(["until-dismissed", ["Until dismissed", "true"]]);
  });

  it("shows a stored choice and follows a change made elsewhere", async () => {
    setA11yPref("noticeTime", "until-dismissed");
    mount(NoticeTimeRow, { attachTo: document.body });
    expect(state().map((s) => s[1])).toEqual(["false", "false", "true"]);
    setA11yPref("noticeTime", "longer");
    await flushPromises();
    expect(state().map((s) => s[1])).toEqual(["false", "true", "false"]);
  });
});

describe("Notification time in Preferences", () => {
  async function access() {
    mount(PreferencesDialog, { attachTo: document.body });
    await new Promise((r) => setTimeout(r, 2));
    await flushPromises();
    $('.prefs-nav-btn[data-category="access"]').click();
    await flushPromises();
  }

  it("sits in Keyboard and pointer right after Hover delay", async () => {
    await access();
    const group = $('[role=group][aria-labelledby="prefs-a11y-input"]');
    const ids = [...group.querySelectorAll(".pref-card")].map((c) => (c.querySelector("[id]") as HTMLElement).id);
    expect(ids.slice(0, 2)).toEqual(["prefs-hover-dwell", "prefs-notice-time"]);
  });

  it("enables Reset when only Notification time differs, and Reset puts it back to Normal", async () => {
    await access();
    const reset = $("[data-a11y-reset]");
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    radios()[2]!.click();
    await flushPromises();
    expect(reset.getAttribute("aria-disabled")).toBeNull();
    reset.click();
    await flushPromises();
    expect([a11yPrefs().noticeTime, state().map((s) => s[1])]).toEqual(["normal", ["true", "false", "false"]]);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
  });
});
