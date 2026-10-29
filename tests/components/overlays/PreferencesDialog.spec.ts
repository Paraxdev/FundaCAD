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
import { experimentalPrefs, resetExperimentalPrefs, setExperimentalPref } from "../../../src/ui/experimentalPrefs";

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

// happy-dom moves no focus on Tab, so the step a browser takes when the dialog lets the key through is taken here.
async function tab(shift = false) {
  const from = document.activeElement as HTMLElement;
  const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  from.dispatchEvent(e);
  if (!e.defaultPrevented) {
    const stops = focusables(document.body);
    stops[stops.indexOf(from) + (shift ? -1 : 1)]?.focus();
  }
  await flushPromises();
}

const stopName = (el: Element | null): string => {
  const h = el as HTMLElement;
  const group = h.closest("[role=radiogroup]");
  if (group) return `${group.id}:${label(h)}`;
  return h.dataset.tab ?? (h.closest("label[id]")?.id || h.id || label(h) || h.getAttribute("aria-label") || "");
};

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

  it("steps Tab and Shift+Tab once per group through the dialog, wrapping at both ends", async () => {
    await open();
    await category("navigation");
    const start = $(".prefs-cats [role=tab][aria-selected=true]");
    start.focus();
    const walk = async (shift: boolean) => {
      const seen: string[] = [];
      do {
        seen.push(stopName(document.activeElement));
        await tab(shift);
      } while (document.activeElement !== start && seen.length < 40);
      return seen;
    };
    const forward = [
      "navigation",
      "prefs-smoothing",
      "prefs-orbit-pivot:Under cursor",
      "prefs-inertia",
      "prefs-wheel-device:Automatic",
      "prefs-touchpad-scroll:Orbits",
      "prefs-classic-camera",
      "Done",
      "Close",
    ];
    expect(await walk(false)).toEqual(forward);
    expect(await walk(true)).toEqual([forward[0], ...forward.slice(1).reverse()]);
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

  it("picks a stored Your own image without the file picker, by arrow and by pointer", async () => {
    const store = memoryImageStore();
    await store.put(new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    useHomeImageStore(store);
    await open();
    const picker = vi.spyOn($("#prefs-home-image"), "click").mockImplementation(() => {});
    radios("prefs-home-background")[1]!.focus();
    await press("ArrowRight");
    const picked = [getHomeBackground(), label(document.activeElement)];
    await press("Home");
    const own = radios("prefs-home-background")[2]!;
    own.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    own.click();
    await flushPromises();
    expect([picker.mock.calls.length, picked, getHomeBackground()]).toEqual([0, ["image", "Your own image"], "image"]);
  });
});

describe("Preferences categories", () => {
  const tabs = () => [...document.querySelectorAll<HTMLElement>(".prefs-cats [role=tab]")];
  const shown = () =>
    [...document.querySelectorAll<HTMLElement>("[role=tabpanel]")].filter((p) => p.style.display !== "none");

  it("draws the categories as one vertical tab list over labelled panes", async () => {
    await open();
    const list = $(".prefs-cats");
    expect([list.getAttribute("role"), list.getAttribute("aria-orientation"), list.getAttribute("aria-label")]).toEqual(
      ["tablist", "vertical", "Preference categories"],
    );
    expect(tabs().map(label)).toEqual([
      "Appearance",
      "Viewport",
      "Navigation",
      "Accessibility",
      "Updates",
      "AI assistants",
      "Plugins",
      "Experimental",
    ]);
    expect(tabs().map((t) => [t.getAttribute("aria-selected"), t.tabIndex])).toEqual(
      tabs().map((_, i) => (i === 0 ? ["true", 0] : ["false", -1])),
    );
    expect(document.querySelectorAll("[role=tabpanel]").length).toBe(8);
    expect(shown().map((p) => p.getAttribute("aria-label"))).toEqual(["Appearance"]);
  });

  it("moves through the categories with the arrows and keeps focus on the tabs", async () => {
    await open();
    tabs()[0]!.focus();
    await press("ArrowDown");
    expect([document.activeElement, shown().map((p) => p.dataset.pane)]).toEqual([tabs()[1], ["viewport"]]);
    await press("End");
    expect([document.activeElement, shown().map((p) => p.dataset.pane)]).toEqual([tabs()[7], ["experimental"]]);
  });

  it("lands on the pane title after a click on a category, or on the pane when it has no title", async () => {
    await open();
    await category("access");
    expect([document.activeElement?.tagName, label(document.activeElement)]).toEqual(["H3", "Accessibility"]);
    await category("updates");
    expect([document.activeElement?.tagName, label(document.activeElement)]).toEqual(["H3", "Updates"]);
    await category("mcp");
    expect(document.activeElement).toBe($("#prefs-pane-mcp"));
  });

  it("leaves focus alone on a click in the list that misses every category", async () => {
    await open();
    const start = document.activeElement;
    $(".prefs-cats").click();
    await flushPromises();
    expect(document.activeElement).toBe(start);
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
    expect((document.activeElement as HTMLElement).dataset.tab).toBe("appearance");
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

  it("closes on the first Escape once a draft is typed back to the stored number", async () => {
    const dialogs = useDialogStore();
    dialogs.preferences = true;
    await open();
    await category("experimental");
    const box = $("#prefs-x-bounces") as HTMLInputElement;
    box.focus();
    for (const text of ["12", "6"]) {
      box.value = text;
      box.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await new Promise((r) => setTimeout(r, 0));
    await press("Escape");
    expect([box.value, dialogs.preferences]).toEqual(["6", false]);
  });

  it("closes on the first Escape after an arrow that the end of the range held still", async () => {
    setExperimentalPref("bounces", 64);
    const dialogs = useDialogStore();
    dialogs.preferences = true;
    await open();
    await category("experimental");
    const box = $("#prefs-x-bounces") as HTMLInputElement;
    box.focus();
    await press("ArrowUp");
    await new Promise((r) => setTimeout(r, 0));
    await press("Escape");
    expect([box.value, experimentalPrefs().bounces, dialogs.preferences]).toEqual(["64", 64, false]);
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
