// The Preferences choices are Segmented groups: one Tab stop each, the arrows move and pick inside a group.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { focusables } from "../../../src/components/ui/focusables";
import { useDialogStore } from "../../../src/stores/dialogs";
import { getUnit, setUnit } from "../../../src/ui/units";
import {
  getHoverDwellMs,
  getNavPrefs,
  noteDetectedWheel,
  setHoverDwellMs,
  setNavPrefs,
} from "../../../src/ui/interactionPrefs";
import { a11yPrefs, getVerbosity, resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";
import { contrastSetting } from "../../../src/ui/contrastSetting";
import { motionOn, setMotion } from "../../../src/ui/motion";
import {
  getHomeBackground,
  memoryImageStore,
  setHomeBackground,
  useHomeImageStore,
} from "../../../src/ui/homeBackground";
import { experimentalPrefs, resetExperimentalPrefs, setExperimentalPref } from "../../../src/ui/experimentalPrefs";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";
import { customThemes, DEFAULT_THEME_ID, getTheme, removeCustomTheme, setTheme, themes } from "../../../src/ui/theme";

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
  return (
    h.dataset.tab ??
    (h.closest("label[id], .ui-slider[id]")?.id || h.id || label(h) || h.getAttribute("aria-label") || "")
  );
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
      ["prefs-contrast", "Contrast", "Follow system|Standard|More|Maximum"],
      ["prefs-viewport-labels", "Viewport labels", "Small|Medium|Large|Extra large"],
      ["prefs-verbosity", "Announcements", "Off|Errors|Normal|Verbose"],
      ["prefs-motion", "Animations", "Follow system|On|Off"],
      ["prefs-env-width", "HDR environment size", expect.stringMatching(/^2048\|4096\|8192\|16384\|GPU maximum/)],
    ]);
  });

  it("gives a group one Tab stop, on its selected choice", async () => {
    await open();
    await category("navigation");
    const pane = $(".prefs-pane:not([style*='none'])");
    expect(focusables(pane).map((el) => el.id || el.closest(".ui-slider[id]")?.id || label(el))).toEqual([
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

  it("the Scrolling hint says what Automatic took the last scroll for, and updates while open", async () => {
    await open();
    await category("navigation");
    const hint = () => $("#prefs-wheel-device-hint").textContent!.replace(/\s+/g, " ");
    expect(hint()).not.toContain("took the last one");
    expect(hint()).toContain("has not seen a scroll over the model yet");
    expect(hint()).toContain("On Mouse a pinch pans too, as Ctrl with a wheel does.");
    noteDetectedWheel("touchpad");
    await flushPromises();
    expect(hint()).toContain("and took the last one for a touchpad");
    noteDetectedWheel("mouse");
    await flushPromises();
    expect(hint()).toContain("and took the last one for a mouse");
    setNavPrefs({ wheelDevice: "touchpad" });
    await flushPromises();
    expect(hint()).not.toContain("took the last one");
    expect(hint()).not.toContain("not seen a scroll");
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
    const first = tabs()[0]!;
    expect(shown().map((p) => [p.dataset.pane, p.id, p.getAttribute("aria-labelledby")])).toEqual([
      ["appearance", first.getAttribute("aria-controls"), first.id],
    ]);
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
    expect(document.activeElement).toBe($('[data-pane="mcp"]'));
  });

  it("opens on the category it was asked for, and on Appearance for one it does not have", async () => {
    useDialogStore().openPreferences("access");
    const w = await open();
    expect([shown().map((p) => p.dataset.pane), label(document.activeElement)]).toEqual([["access"], "Accessibility"]);
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    w.unmount();
    useDialogStore().openPreferences("nope");
    await open();
    expect(shown().map((p) => p.dataset.pane)).toEqual(["appearance"]);
  });

  it("forgets the asked category once open, so the Live session pill's plain open lands on Appearance", async () => {
    const d = useDialogStore();
    d.openPreferences("access");
    const w = await open();
    expect([d.prefsCategory, shown().map((p) => p.dataset.pane)]).toEqual([null, ["access"]]);
    d.preferences = false;
    w.unmount();
    d.preferences = true;
    await open();
    expect([d.prefsCategory, shown().map((p) => p.dataset.pane)]).toEqual([null, ["appearance"]]);
  });

  it("switches to a category asked for while it is open and lands on its title", async () => {
    const d = useDialogStore();
    await open();
    d.openPreferences("access");
    await flushPromises();
    expect([d.prefsCategory, shown().map((p) => p.dataset.pane), label(document.activeElement)]).toEqual([
      null,
      ["access"],
      "Accessibility",
    ]);
    expect(document.activeElement?.tagName).toBe("H3");
    d.openPreferences();
    await flushPromises();
    expect(shown().map((p) => p.dataset.pane)).toEqual(["access"]);
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
    await category("navigation");
    $("#prefs-inertia input").focus();
    await press(" ");
    expect(getNavPrefs().inertia).toBe(true);
    await press(" ", { repeat: true });
    expect(getNavPrefs().inertia).toBe(true);
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

describe("Preferences Accessibility", () => {
  beforeEach(() => resetA11yPrefs());
  const solidBox = () => $("#prefs-solid-panels input[type=checkbox]") as HTMLInputElement;
  const groupName = (g: Element) => $(`#${g.getAttribute("aria-labelledby")}`).textContent?.trim();
  const pick = async (group: string, choice: string) => {
    radios(group)
      .find((r) => label(r) === choice)!
      .click();
    await flushPromises();
  };

  it("draws the groups Vision, Speech, Keyboard and pointer and Motion, each named by its heading", async () => {
    await open();
    await category("access");
    const groups = [...$('[data-pane="access"]').querySelectorAll("[role=group]")];
    expect(groups.map(groupName)).toEqual(["Vision", "Speech", "Keyboard and pointer", "Motion"]);
  });

  it("picks Animations from Follow system, On and Off, and says what the system has while following it", async () => {
    await open();
    await category("access");
    expect(radios("prefs-motion").map(label)).toEqual(["Follow system", "On", "Off"]);
    expect($("#prefs-motion").getAttribute("aria-describedby")).toBe("prefs-motion-hint");
    expect($("#prefs-motion-hint").textContent).toContain("Right now the system has animations on.");
    await pick("prefs-motion", "Off");
    expect([a11yPrefs().animations, motionOn()]).toEqual(["off", false]);
    expect($("#prefs-motion-hint").textContent).not.toContain("right now");
    await pick("prefs-motion", "Follow system");
    expect([a11yPrefs().animations, motionOn()]).toEqual(["system", true]);
  });

  it("sets the Announcements level the announcer reads", async () => {
    await open();
    await category("access");
    expect(radios("prefs-verbosity").map(label)).toEqual(["Off", "Errors", "Normal", "Verbose"]);
    await pick("prefs-verbosity", "Errors");
    expect(getVerbosity()).toBe("errors");
  });

  it("names Hover delay and speaks its value in milliseconds as the arrows move it", async () => {
    await open();
    await category("access");
    const input = $("#prefs-hover-dwell input[type=range]");
    expect($(`#${input.getAttribute("aria-labelledby")}`).textContent).toBe("Hover delay");
    expect(input.getAttribute("aria-valuetext")).toBe("800 ms");
    input.focus();
    await press("ArrowRight");
    expect(getHoverDwellMs()).toBe(850);
    expect(input.getAttribute("aria-valuetext")).toBe("850 ms");
  });

  it("turns Single key shortcuts on and off with a themed checkbox that says what stays", async () => {
    await open();
    await category("access");
    const box = $("#prefs-single-keys input[type=checkbox]") as HTMLInputElement;
    expect([box.checked, $("#prefs-single-keys").closest("[role=group]")?.getAttribute("aria-labelledby")]).toEqual([
      true,
      "prefs-a11y-input",
    ]);
    expect(box.getAttribute("aria-describedby")).toBe("prefs-single-keys-hint");
    const hint = $("#prefs-single-keys-hint").textContent ?? "";
    for (const kept of ["Ctrl or Cmd", "Escape", "Delete", "F keys", "arrows", "command palette", "voice control"])
      expect(hint).toContain(kept);
    box.click();
    await flushPromises();
    expect([a11yPrefs().singleKeys, box.checked]).toEqual([false, false]);
    expect($("[data-a11y-reset]").getAttribute("aria-disabled")).toBeNull();
    box.click();
    await flushPromises();
    expect([a11yPrefs().singleKeys, box.checked]).toEqual([true, true]);
  });

  it("the Screen reader preset unticks Single key shortcuts and Reset to defaults ticks it again", async () => {
    await open();
    await category("access");
    const box = $("#prefs-single-keys input[type=checkbox]") as HTMLInputElement;
    expect($("#prefs-a11y-actions-hint").textContent).toContain("turns Single key shortcuts off");
    $("[data-a11y-preset]").click();
    await flushPromises();
    expect([a11yPrefs().singleKeys, box.checked]).toEqual([false, false]);
    expect($("#prefs-a11y-preset-status").textContent).toBe(
      "Announcements set to Verbose, Single key shortcuts turned off and Solid panels on.",
    );
    $("[data-a11y-reset]").click();
    await flushPromises();
    expect([a11yPrefs().singleKeys, box.checked]).toEqual([true, true]);
  });

  it("applies the Screen reader preset, and Reset to defaults clears every choice, Hover delay too", async () => {
    await open();
    await category("access");
    const reset = $("[data-a11y-reset]");
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    $("[data-a11y-preset]").click();
    await flushPromises();
    expect(getVerbosity()).toBe("verbose");
    expect(label(radios("prefs-verbosity").find((r) => r.getAttribute("aria-checked") === "true")!)).toBe("Verbose");
    expect(solidBox().checked).toBe(true);
    setA11yPref("animations", "off");
    setHoverDwellMs(1200);
    await flushPromises();
    expect(reset.getAttribute("aria-disabled")).toBeNull();
    reset.click();
    await flushPromises();
    expect([a11yPrefs().animations, getVerbosity(), getHoverDwellMs()]).toEqual(["system", "normal", 800]);
    expect([a11yPrefs().solidPanels, solidBox().checked]).toEqual([false, false]);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
  });

  it("holds Interface size in the Vision group, and Reset to defaults puts a changed size back to 100", async () => {
    await open();
    await category("access");
    expect($("#prefs-interface-size").closest("[role=group]")!.getAttribute("aria-labelledby")).toBe(
      "prefs-a11y-vision",
    );
    const reset = $("[data-a11y-reset]");
    setA11yPref("interfaceSize", 125);
    await flushPromises();
    expect(reset.getAttribute("aria-disabled")).toBeNull();
    reset.click();
    await flushPromises();
    expect([a11yPrefs().interfaceSize, label($("#prefs-interface-size"))]).toEqual([100, "100%"]);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
  });

  it("lets Reset to defaults put a changed Viewport labels size back to Medium", async () => {
    await open();
    await category("access");
    const reset = $("[data-a11y-reset]");
    setA11yPref("viewportLabels", "l");
    await flushPromises();
    expect(reset.getAttribute("aria-disabled")).toBeNull();
    reset.click();
    await flushPromises();
    expect(a11yPrefs().viewportLabels).toBe("m");
    expect(reset.getAttribute("aria-disabled")).toBe("true");
  });

  it("counts a Contrast or Solid panels choice as a change Reset to defaults clears", async () => {
    await open();
    await category("access");
    const reset = $("[data-a11y-reset]");
    for (const set of [() => setA11yPref("contrast", "standard"), () => setA11yPref("solidPanels", true)]) {
      set();
      await flushPromises();
      expect(reset.getAttribute("aria-disabled")).toBeNull();
      reset.click();
      await flushPromises();
      expect([a11yPrefs().contrast, a11yPrefs().solidPanels]).toEqual(["system", false]);
      expect(reset.getAttribute("aria-disabled")).toBe("true");
    }
  });

  it("picks Contrast from Follow system, Standard, More and Maximum, and says what the system asks for", async () => {
    await open();
    await category("access");
    expect($("#prefs-contrast").getAttribute("aria-describedby")).toBe("prefs-contrast-hint");
    expect($("#prefs-contrast-hint").textContent).toContain("Right now the system asks for standard contrast.");
    await pick("prefs-contrast", "Maximum");
    expect([a11yPrefs().contrast, contrastSetting()]).toEqual(["maximum", "maximum"]);
    expect($("#prefs-contrast-hint").textContent).not.toContain("Right now");
    await pick("prefs-contrast", "More");
    expect(contrastSetting()).toBe("more");
    await pick("prefs-contrast", "Follow system");
    expect([a11yPrefs().contrast, contrastSetting()]).toEqual(["system", "standard"]);
  });

  it("turns Solid panels on and off, and shows it on and locked while More or Maximum contrast implies it", async () => {
    await open();
    await category("access");
    const box = solidBox();
    const locked = () => box.getAttribute("aria-disabled") === "true";
    expect([box.checked, locked(), box.getAttribute("aria-describedby")]).toEqual([
      false,
      false,
      "prefs-solid-panels-hint",
    ]);
    box.click();
    await flushPromises();
    expect(a11yPrefs().solidPanels).toBe(true);
    box.click();
    await flushPromises();
    expect(a11yPrefs().solidPanels).toBe(false);
    await pick("prefs-contrast", "More");
    expect([box.checked, locked()]).toEqual([true, true]);
    box.click();
    await flushPromises();
    expect([box.checked, a11yPrefs().solidPanels]).toEqual([true, false]);
    await pick("prefs-contrast", "Standard");
    expect([box.checked, locked()]).toEqual([false, false]);
  });

  it("says the Screen reader preset took in a status line, again on a second press, gone once a choice it made moves", async () => {
    await open();
    await category("access");
    const status = $("#prefs-a11y-preset-status");
    expect([status.getAttribute("role"), status.textContent]).toEqual(["status", ""]);
    $("[data-a11y-preset]").click();
    await flushPromises();
    expect(status.textContent).toBe(
      "Announcements set to Verbose, Single key shortcuts turned off and Solid panels on.",
    );
    const seen: string[] = [];
    const watcher = new MutationObserver(() => seen.push(status.textContent ?? ""));
    watcher.observe(status, { childList: true, characterData: true, subtree: true });
    $("[data-a11y-preset]").click();
    await flushPromises();
    watcher.disconnect();
    expect(seen).toEqual(["", "Announcements set to Verbose, Single key shortcuts turned off and Solid panels on."]);
    await pick("prefs-verbosity", "Normal");
    expect(status.textContent).toBe("");
    $("[data-a11y-preset]").click();
    await flushPromises();
    solidBox().click();
    await flushPromises();
    expect(status.textContent).toBe("");
  });

  it("opens Appearance from the Vision group and lands on its title", async () => {
    await open();
    await category("access");
    $("[data-a11y-appearance]").click();
    await flushPromises();
    expect($('[data-pane="appearance"]').style.display).not.toBe("none");
    expect(document.activeElement).toBe($('[data-pane="appearance"] .prefs-pane-title'));
    expect($(".prefs-nav-btn.active").dataset.category).toBe("appearance");
  });
});

describe("Preferences sliders, hints and upload errors", () => {
  const slider = (id: string) => $(`#${id} input[type=range]`);
  const name = (el: HTMLElement) => $(`#${el.getAttribute("aria-labelledby")}`).textContent;

  async function pickFile(id: string, file: File) {
    const input = $(`#${id}`) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change"));
    await flushPromises();
  }

  beforeEach(() => {
    setRenderPref("brightness", 1);
    setRenderPref("bloom", 0.4);
    setNavPrefs({ smoothTime: 0.1 });
  });

  it("speaks Environment brightness and Bloom in percent and Smoothing in milliseconds", async () => {
    await open();
    const rows = [
      ["prefs-brightness", "Environment brightness", "100%", () => renderPrefs().brightness, 1.05, "105%"],
      ["prefs-bloom", "Bloom", "40%", () => renderPrefs().bloom, 0.45, "45%"],
      ["prefs-smoothing", "Smoothing", "100 ms", () => getNavPrefs().smoothTime, 0.105, "105 ms"],
    ] as const;
    for (const [id, text, before, read, after, spoken] of rows) {
      const input = slider(id);
      expect([name(input), input.getAttribute("aria-valuetext")]).toEqual([text, before]);
      input.focus();
      await press("ArrowRight");
      expect([read(), input.getAttribute("aria-valuetext")]).toEqual([after, spoken]);
    }
  });

  it("links each slider's range to the hint under it and hides the readout that repeats its value", async () => {
    await open();
    const ids = ["prefs-hover-dwell", "prefs-brightness", "prefs-bloom", "prefs-smoothing"];
    const links = ids.map((id) => {
      const input = slider(id);
      return [
        input.getAttribute("aria-describedby"),
        input.closest(".pref-card")!.querySelector(".pref-hint")!.id,
        $(`#${id} output`).getAttribute("aria-hidden"),
      ];
    });
    expect(links).toEqual(ids.map((id) => [`${id}-hint`, `${id}-hint`, "true"]));
  });

  it("links each choice to the hint under it, and every description it names has text", async () => {
    await open();
    expect($("#prefs-orbit-pivot").getAttribute("aria-describedby")).toBe("prefs-orbit-pivot-hint");
    expect($("#prefs-theme").getAttribute("aria-describedby")).toBe("prefs-theme-hint");
    const refs = [...document.querySelectorAll(".prefs-panel [aria-describedby]")].flatMap((el) =>
      el.getAttribute("aria-describedby")!.split(" "),
    );
    expect(refs.length).toBeGreaterThanOrEqual(12);
    for (const ref of refs) expect(document.getElementById(ref)?.textContent?.trim(), ref).toBeTruthy();
  });

  it("names every theme FundaCAD ships in the theme hint, and the vision themes in the Accessibility one", async () => {
    await open();
    const text = (id: string) => $(`#${id}`).textContent!.replace(/\s+/g, " ");
    const shipped = themes().filter((t) => !t.custom);
    expect(shipped.filter((t) => !text("prefs-theme-hint").includes(t.label)).map((t) => t.label)).toEqual([]);
    for (const label of ["High Contrast Dark", "High Contrast Light", "Colour-Blind Safe", "FundaCAD Light"]) {
      expect(text("prefs-a11y-theme-hint")).toContain(label);
    }
  });

  it("keeps both upload errors as empty alerts until a refused file fills them", async () => {
    await open();
    const errors = ["prefs-theme-error", "prefs-home-image-error"].map((id) => $(`#${id}`));
    expect(errors.map((e) => [e.getAttribute("role"), e.textContent])).toEqual([
      ["alert", ""],
      ["alert", ""],
    ]);
    await pickFile("prefs-theme-file", new File(["{ not json"], "bad.json", { type: "application/json" }));
    await vi.waitFor(() => expect(errors[0]!.textContent).toBe("That file is not valid JSON."));
    await pickFile("prefs-home-image", new File(["text"], "notes.txt", { type: "text/plain" }));
    await vi.waitFor(() => expect(errors[1]!.textContent).toBe("Pick a PNG or JPEG picture."));
  });

  it("lists the pairs an uploaded palette fails in a status line, and leaves it empty for one that passes", async () => {
    const json = (o: object, name: string) => new File([JSON.stringify(o)], name, { type: "application/json" });
    try {
      await open();
      const warning = $("#prefs-theme-warning");
      expect([warning.getAttribute("role"), warning.textContent]).toEqual(["status", ""]);
      await pickFile("prefs-theme-file", json({ label: "Murk", "--text-mute": "#4a4458" }, "murk.json"));
      await vi.waitFor(() => expect(warning.textContent).toMatch(/^Murk is added, but \d+ colour pairs? fall/));
      expect(warning.textContent).toContain("--text-mute on --panel at ");
      expect(getTheme()).toBe(customThemes().find((t) => t.label === "Murk")?.id);
      await pickFile("prefs-theme-file", json({ label: "Fine", "--accent": "#9a9ff0" }, "fine.json"));
      await vi.waitFor(() => expect(getTheme()).toBe(customThemes().find((t) => t.label === "Fine")?.id));
      await flushPromises();
      expect(warning.textContent).toBe("");
    } finally {
      setTheme(DEFAULT_THEME_ID);
      for (const t of customThemes()) removeCustomTheme(t.id);
    }
  });
});

// axe's name, id and reference rules on all eight panes: the harness's axe run sees only the pane that is open.
describe("Preferences names on every pane", () => {
  const CONTROLS =
    "button, input, select, textarea, [role=tab], [role=radio], [role=checkbox], [role=switch], [role=combobox]," +
    " [role=slider], [role=radiogroup], [role=group], [role=tabpanel], [role=tablist], [role=dialog]";
  const FROM_CONTENT = new Set(["button", "tab", "radio", "checkbox", "switch"]);
  const LABELABLE = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA"]);
  const roleOf = (el: Element) => el.getAttribute("role") ?? (el.tagName === "BUTTON" ? "button" : "");
  const hidden = (el: Element) =>
    !!el.closest("[hidden], [aria-hidden=true], .hidden") || (el as HTMLInputElement).type === "hidden";
  const textOf = (ids: string) =>
    ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .join(" ")
      .trim();
  const nameOf = (el: HTMLElement) => {
    const by = el.getAttribute("aria-labelledby");
    if (by) return textOf(by);
    const forLabel = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return (
      el.getAttribute("aria-label")?.trim() ||
      forLabel?.textContent?.trim() ||
      (LABELABLE.has(el.tagName) ? el.closest("label")?.textContent?.trim() : "") ||
      (FROM_CONTENT.has(roleOf(el)) ? el.textContent?.trim() : "") ||
      ""
    );
  };

  it("gives every control a name, every id once, and every id it points at", async () => {
    await open();
    const dialog = $(".prefs-panel").closest<HTMLElement>("[role=dialog]")!;
    const panes = [...dialog.querySelectorAll<HTMLElement>("[role=tabpanel]")].map((p) => p.dataset.pane);
    expect(panes).toEqual([
      "appearance",
      "viewport",
      "navigation",
      "access",
      "updates",
      "mcp",
      "plugins",
      "experimental",
    ]);
    const all = [dialog, ...dialog.querySelectorAll<HTMLElement>("*")];
    // The plugin address field has only a placeholder until the base TextField takes a label.
    const nameless = all
      .filter((el) => el.matches(CONTROLS) && !hidden(el) && !nameOf(el) && !el.closest(".plug-address"))
      .map((el) => `${el.closest<HTMLElement>("[data-pane]")?.dataset.pane}: ${el.outerHTML.slice(0, 120)}`);
    const ids = all.map((el) => el.id).filter(Boolean);
    const twice = ids.filter((id, i) => ids.indexOf(id) !== i);
    const dangling = all.flatMap((el) =>
      ["aria-labelledby", "aria-describedby", "aria-controls", "for"].flatMap((a) =>
        (el.getAttribute(a) ?? "")
          .split(/\s+/)
          .filter((id) => id && !document.getElementById(id))
          .map((id) => `${a}=${id}`),
      ),
    );
    expect({ nameless, twice, dangling }).toEqual({ nameless: [], twice: [], dangling: [] });
  });
});
