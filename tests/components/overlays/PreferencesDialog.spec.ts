// The Preferences choices are Segmented groups: one Tab stop each, the arrows move and pick inside a group.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import { focusables } from "../../../src/components/ui/focusables";
import { useDialogStore } from "../../../src/stores/dialogs";
import { getUnit, setUnit } from "../../../src/ui/units";
import { getHoverDwellMs, getNavPrefs, setHoverDwellMs, setNavPrefs } from "../../../src/ui/interactionPrefs";
import { a11yPrefs, getVerbosity, resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";
import { motionOn, setMotion } from "../../../src/ui/motion";
import {
  getHomeBackground,
  memoryImageStore,
  setHomeBackground,
  useHomeImageStore,
} from "../../../src/ui/homeBackground";
import { experimentalPrefs, resetExperimentalPrefs, setExperimentalPref } from "../../../src/ui/experimentalPrefs";
import { renderPrefs, setRenderPref } from "../../../src/ui/renderPrefs";

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

  it("applies the Screen reader preset, and Reset to defaults clears every choice, Hover delay too", async () => {
    await open();
    await category("access");
    const reset = $("[data-a11y-reset]");
    expect(reset.getAttribute("aria-disabled")).toBe("true");
    $("[data-a11y-preset]").click();
    await flushPromises();
    expect(getVerbosity()).toBe("verbose");
    expect(label(radios("prefs-verbosity").find((r) => r.getAttribute("aria-checked") === "true")!)).toBe("Verbose");
    setA11yPref("animations", "off");
    setHoverDwellMs(1200);
    await flushPromises();
    expect(reset.getAttribute("aria-disabled")).toBeNull();
    reset.click();
    await flushPromises();
    expect([a11yPrefs().animations, getVerbosity(), getHoverDwellMs()]).toEqual(["system", "normal", 800]);
    expect(reset.getAttribute("aria-disabled")).toBe("true");
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
