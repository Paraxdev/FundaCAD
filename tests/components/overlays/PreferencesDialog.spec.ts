// The Preferences choices are Segmented groups: one Tab stop each, the arrows move and pick inside a group.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { focusables } from "../../../src/components/ui/focusables";
import { useDialogStore } from "../../../src/stores/dialogs";
import { getUnit, setUnit } from "../../../src/ui/units";
import { getNavPrefs, setNavPrefs } from "../../../src/ui/interactionPrefs";
import { motionOn, setMotion } from "../../../src/ui/motion";
import {
  getHomeBackground,
  memoryImageStore,
  setHomeBackground,
  useHomeImageStore,
} from "../../../src/ui/homeBackground";
import { experimentalPrefs, resetExperimentalPrefs } from "../../../src/ui/experimentalPrefs";

enableAutoUnmount(afterEach);

async function open() {
  const w = mount(PreferencesDialog, { attachTo: document.body });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  await flushPromises();
  return w;
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const radios = (group: string) => [...$(`#${group}`).querySelectorAll<HTMLElement>("[role=radio]")];
const label = (el: Element | null) => el?.textContent?.trim();

async function press(key: string, init: KeyboardEventInit = {}) {
  const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  (document.activeElement ?? document.body).dispatchEvent(e);
  await flushPromises();
}

async function category(id: string) {
  $(`.prefs-nav-btn[data-category="${id}"]`).click();
  await flushPromises();
}

beforeEach(() => {
  setActivePinia(createPinia());
  setUnit("mm");
  setNavPrefs({ orbitPivot: "auto", wheelDevice: "auto", touchpadScroll: "orbit", inertia: false });
  setMotion(true);
  setHomeBackground("paper");
  useHomeImageStore(memoryImageStore());
  resetExperimentalPrefs();
});

describe("Preferences choices", () => {
  it("draws every choice group as a radiogroup that keeps its id, name and choices", async () => {
    await open();
    const groups = [...document.querySelectorAll(".prefs-panel [role=radiogroup]")].map((g) => [
      g.id,
      g.getAttribute("aria-label"),
      [...g.querySelectorAll("[role=radio]")].map(label).join("|"),
    ]);
    expect(groups).toEqual([
      ["prefs-unit", "Units", "mm|cm|in"],
      ["prefs-home-background", "Home background", "Paper|Workspace|Your own image"],
      ["prefs-background", "Background", "Theme|Dark|Grey|Light"],
      ["prefs-tangent-edges", "Tangent edges", "Show|Faint|Hide"],
      ["prefs-tracer", "Path tracer", "Auto|Native|WebGPU"],
      ["prefs-orbit-pivot", "Orbit pivot", "Under cursor|Origin|Selection"],
      ["prefs-wheel-device", "Scrolling", "Automatic|Touchpad|Mouse"],
      ["prefs-touchpad-scroll", "Two-finger scroll", "Orbits|Pans"],
      ["prefs-env-width", "HDR environment size", expect.stringMatching(/^2048\|4096\|8192\|16384\|GPU maximum/)],
    ]);
  });

  it("gives a group one Tab stop, on its selected choice", async () => {
    await open();
    await category("navigation");
    const pane = $(".prefs-pane:not([style*='none'])");
    expect(focusables(pane).map((el) => el.id || label(el))).toEqual([
      "prefs-smoothing",
      "Under cursor",
      "",
      "Automatic",
      "Orbits",
      "",
    ]);
    expect(focusables(pane).filter((el) => el.matches("input[type=checkbox]")).length).toBe(2);
    for (const g of ["prefs-orbit-pivot", "prefs-wheel-device", "prefs-touchpad-scroll"])
      expect(radios(g).map((r) => [r.tabIndex, r.getAttribute("aria-checked")])).toEqual(
        radios(g).map((r) => (r.getAttribute("aria-checked") === "true" ? [0, "true"] : [-1, "false"])),
      );
  });

  it("moves and picks with the arrows, Home and End, wrapping at the ends", async () => {
    await open();
    radios("prefs-unit")[0]!.focus();
    await press("ArrowRight");
    expect([getUnit(), label(document.activeElement)]).toEqual(["cm", "cm"]);
    await press("End");
    expect([getUnit(), label(document.activeElement)]).toEqual(["in", "in"]);
    await press("ArrowRight");
    expect([getUnit(), label(document.activeElement)]).toEqual(["mm", "mm"]);
    await press("ArrowLeft");
    expect(getUnit()).toBe("in");
    await press("Home");
    expect(getUnit()).toBe("mm");
    expect(radios("prefs-unit").map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });

  it("still picks a choice on a click, as the e2e scripts do", async () => {
    await open();
    await category("navigation");
    [...radios("prefs-touchpad-scroll")].find((r) => label(r) === "Pans")!.click();
    await flushPromises();
    expect(getNavPrefs().touchpadScroll).toBe("pan");
    expect(radios("prefs-touchpad-scroll").map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("arrows onto Your own image without opening the file picker, a pointer pick still opens it", async () => {
    await open();
    const picker = vi.spyOn($("#prefs-home-image"), "click").mockImplementation(() => {});
    radios("prefs-home-background")[1]!.focus();
    await press("ArrowRight");
    await press("End");
    const chooser = () =>
      [...$("#prefs-home-background").closest(".pref-card")!.querySelectorAll(".prefs-actions button")].map(label);
    expect([picker.mock.calls.length, getHomeBackground(), label(document.activeElement), chooser()]).toEqual([
      0,
      "image",
      "Your own image",
      ["Choose image…"],
    ]);
    await press("Home");
    const own = radios("prefs-home-background")[2]!;
    own.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    own.click();
    await flushPromises();
    expect([picker.mock.calls.length, getHomeBackground()]).toEqual([1, "paper"]);
  });
});

describe("Preferences settings and frame", () => {
  it("toggles a setting once with Space on its checkbox", async () => {
    await open();
    await category("access");
    $("#prefs-motion input").focus();
    await press(" ");
    expect(motionOn()).toBe(false);
    await press(" ", { repeat: true });
    expect(motionOn()).toBe(false);
  });

  it("opens with focus on the open category, and Done closes it", async () => {
    const dialogs = useDialogStore();
    dialogs.preferences = true;
    await open();
    expect((document.activeElement as HTMLElement).dataset.category).toBe("appearance");
    [...document.querySelectorAll<HTMLElement>(".modal-foot button")].find((b) => label(b) === "Done")!.click();
    expect(dialogs.preferences).toBe(false);
  });

  it("reverts a drafted Experimental number on Escape, the next Escape closes the dialog", async () => {
    const dialogs = useDialogStore();
    dialogs.preferences = true;
    await open();
    await category("experimental");
    const box = $("#prefs-x-bounces") as HTMLInputElement;
    const draft = async (text: string) => {
      box.focus();
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
      await flushPromises();
    };
    const settle = () => new Promise((r) => setTimeout(r, 0));
    await draft("999");
    await press("Enter");
    await press("Escape");
    await settle();
    await draft("12");
    await press("Escape");
    await settle();
    expect([box.value, experimentalPrefs().bounces, dialogs.preferences]).toEqual(["6", 6, true]);
    await press("ArrowUp");
    await press("Escape");
    await settle();
    expect([box.value, dialogs.preferences]).toEqual(["6", true]);
    await press("Escape");
    expect(dialogs.preferences).toBe(false);
  });

  it("lets Escape close the dialog from a refused number once focus has left it", async () => {
    const dialogs = useDialogStore();
    dialogs.preferences = true;
    await open();
    await category("experimental");
    const box = $("#prefs-x-bounces") as HTMLInputElement;
    box.focus();
    box.value = "999";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    await press("Enter");
    $("[data-experimental-reset]").focus();
    await new Promise((r) => setTimeout(r, 0));
    await press("Escape");
    expect(dialogs.preferences).toBe(false);
  });
});
