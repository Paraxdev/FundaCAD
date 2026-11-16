// Preferences and its sections read in the chosen language, and follow a switch made while the dialog is open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const h = vi.hoisted(() => ({ confirm: vi.fn(), choose: vi.fn(), open: vi.fn(async (_url: string) => {}) }));
vi.mock("../../../src/ui/choice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/choice")>()),
  confirmDanger: h.confirm,
  choose: h.choose,
}));
vi.mock("../../../src/ui/welcome", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/ui/welcome")>()),
  openExternal: h.open,
}));
vi.mock("../../../src/ui/updates", () => ({ updatesSupported: async () => true }));

import PreferencesDialog from "../../../src/components/overlays/PreferencesDialog.vue";
import ExperimentalSection from "../../../src/components/overlays/ExperimentalSection.vue";
import McpSection from "../../../src/components/overlays/McpSection.vue";
import UpdatesSection from "../../../src/components/overlays/UpdatesSection.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { LiveState } from "../../../src/live/liveSession";
import { setLanguage } from "../../../src/i18n";
import { noteDetectedWheel, setNavPrefs } from "../../../src/ui/interactionPrefs";
import { resetA11yPrefs, setA11yPref } from "../../../src/ui/a11yPrefs";
import { resetExperimentalPrefs, setExperimentalPref } from "../../../src/ui/experimentalPrefs";
import { setLiveEditingMode } from "../../../src/ui/liveEditing";
import { adoptBuildChannel } from "../../../src/ui/updateChannel";

enableAutoUnmount(afterEach);

const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!;
const text = (sel: string) => $(sel).textContent?.replace(/\s+/g, " ").trim();
const radios = (group: string) =>
  [...$(`#${group}`).querySelectorAll<HTMLElement>("[role=radio]")].map((r) => r.textContent?.trim());

async function open() {
  const w = mount(PreferencesDialog, { attachTo: document.body });
  await new Promise((r) => setTimeout(r, 2));
  await flushPromises();
  return w;
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetA11yPrefs();
  resetExperimentalPrefs();
  setNavPrefs({ orbitPivot: "auto", wheelDevice: "auto", touchpadScroll: "orbit", inertia: false });
  h.confirm.mockReset();
  h.choose.mockReset();
});
afterEach(async () => {
  await setLanguage("system");
  adoptBuildChannel("beta");
  localStorage.clear();
});

describe("the dialog in German", () => {
  it("reads its title, tabs, pane titles and controls in German", async () => {
    await setLanguage("de");
    await open();
    expect(text(".modal-head")).toContain("Einstellungen");
    const tabs = [...document.querySelectorAll<HTMLElement>("[role=tab]")].map((t) => t.textContent?.trim());
    expect(tabs).toEqual([
      "Darstellung",
      "3D-Ansicht",
      "Navigation",
      "Barrierefreiheit",
      "Updates",
      "KI-Assistenten",
      "Plug-ins",
      "Experimentell",
    ]);
    expect(text(".modal-foot")).toBe("Fertig");
    expect(text("label[for=prefs-theme]")).toBe("Design");
    expect(text("#prefs-theme-hint")).toBe(
      "System folgt den Hell-, Dunkel- und Kontrasteinstellungen Ihres Computers.",
    );
    expect(text("label[for=prefs-environment]")).toBe("Spiegelungen");
    expect(radios("prefs-background")).toEqual(["Design", "Dunkel", "Grau", "Hell"]);
    expect(radios("prefs-tracer")).toEqual(["Automatisch", "Nativ", "WebGPU"]);
    expect(radios("prefs-orbit-pivot")).toEqual(["Unter dem Zeiger", "Ursprung", "Auswahl"]);
    expect(radios("prefs-verbosity")).toEqual(["Aus", "Fehler", "Normal", "Ausführlich"]);
    expect(radios("prefs-motion")).toEqual(["System folgen", "Ein", "Aus"]);
    expect(radios("prefs-notice-time")).toHaveLength(3);
    expect(text("#prefs-interface-size-hint")).toContain("Ctrl+Plus");
  });

  it("leaves no English title in the panes", async () => {
    await setLanguage("de");
    await open();
    const english = ["Theme", "Reflections", "Background", "Smoothing", "Scrolling", "Contrast", "Announcements"];
    const shown = [...document.querySelectorAll<HTMLElement>(".pref-title, .prefs-group-title, .prefs-pane-title")].map(
      (e) => e.textContent?.trim(),
    );
    for (const w of english) expect(shown).not.toContain(w);
  });

  it("follows a switch made while it is open, lists included", async () => {
    await open();
    expect(radios("prefs-background")).toEqual(["Theme", "Dark", "Grey", "Light"]);
    await setLanguage("fr");
    await flushPromises();
    expect(radios("prefs-background")).toEqual(["Thème", "Sombre", "Gris", "Clair"]);
    expect(text("label[for=prefs-environment]")).toBe("Reflets");
    expect(radios("prefs-orbit-pivot")[0]).toBe("Sous le curseur");
  });
});

describe("the sentences that pick a branch", () => {
  it("says what the scroll was taken for in each state, and nothing when a device is picked", async () => {
    await open();
    expect(text("#prefs-wheel-device-hint")).toContain("has not seen a scroll over the model yet");
    noteDetectedWheel("mouse");
    await flushPromises();
    expect(text("#prefs-wheel-device-hint")).toContain("took the last one for a mouse");
    await setLanguage("de");
    await flushPromises();
    expect(text("#prefs-wheel-device-hint")).toContain("hielt das letzte für eine Maus");
    expect(text("#prefs-wheel-device-hint")).not.toContain("took the last");
    setNavPrefs({ wheelDevice: "touchpad" });
    await flushPromises();
    expect(text("#prefs-wheel-device-hint")).not.toContain("hielt das letzte");
    expect(text("#prefs-wheel-device-hint")).toContain("Wählen Sie eines, wenn es falsch rät.");
  });

  it("says what the system asks for under Animations and Contrast only while following it", async () => {
    await setLanguage("de");
    await open();
    expect(text("#prefs-motion-hint")).toContain("Im Moment hat das System die Animationen");
    expect(text("#prefs-contrast-hint")).toContain("Im Moment");
    setA11yPref("animations", "off");
    setA11yPref("contrast", "more");
    await flushPromises();
    expect(text("#prefs-motion-hint")).not.toContain("Im Moment");
    expect(text("#prefs-contrast-hint")).not.toContain("Im Moment");
  });

  it("asks before resetting the accessibility settings, in the language", async () => {
    await setLanguage("de");
    await open();
    h.confirm.mockResolvedValue(false);
    setA11yPref("verbosity", "verbose");
    await flushPromises();
    $("[data-a11y-reset]").click();
    await flushPromises();
    expect(h.confirm).toHaveBeenCalledWith(
      "Barrierefreiheitseinstellungen zurücksetzen?",
      "Zurücksetzen",
      expect.stringContaining("Überfahren"),
    );
  });
});

describe("the Experimental section in German", () => {
  it("names the groups and fields, and asks about a reset with the group's name", async () => {
    await setLanguage("de");
    setExperimentalPref("sampleCap", 128);
    h.confirm.mockResolvedValue(false);
    const w = mount(ExperimentalSection, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain("Pfadverfolgung");
    expect(w.text()).toContain("Samples pro Pixel");
    expect(w.text()).toContain("Geändert");
    expect(w.text()).toContain("Standard:");
    await w.get('[data-experimental-reset="pathTraced"]').trigger("click");
    await flushPromises();
    const [title, action, body] = h.confirm.mock.calls[0]!;
    expect(title).toContain("Pfadverfolgung");
    expect(action).toBe("Zurücksetzen");
    expect(body).toBe("Jede Grenze für „Pfadverfolgung“ kehrt zu ihrem Standardwert zurück.");
  });
});

function engineWith(state: LiveState) {
  const live = { snapshot: state, subscribe: (fn: (s: LiveState) => void) => (fn(state), () => {}) };
  return { live } as unknown as Engine;
}

describe("the MCP status", () => {
  const status = async (state: LiveState, mode: "edit" | "read") => {
    setLiveEditingMode(mode);
    const w = mount(McpSection, { global: { provide: { [ENGINE as symbol]: engineWith(state) } } });
    await flushPromises();
    return w.get("#prefs-mcp-status").text();
  };
  const guests = (...names: string[]): LiveState => ({ sharing: true, guests: names, lastEdit: null });

  it("names one assistant or counts several, and says whether they can edit, in German", async () => {
    await setLanguage("de");
    expect(await status(guests("Claude Code"), "edit")).toBe("Claude Code ist verbunden und darf bearbeiten.");
    expect(await status(guests("Claude Code"), "read")).toBe("Claude Code ist verbunden, nur lesend.");
    expect(await status(guests("A", "B"), "edit")).toBe("2 Assistenten sind verbunden und dürfen bearbeiten.");
  });

  it("keeps the English wording in English, one or several", async () => {
    expect(await status(guests("A", "B"), "read")).toBe("2 assistants are connected, read only.");
    expect(await status(guests("A"), "read")).toBe("A is connected, read only.");
    expect(await status(guests("A"), "edit")).toBe("A is connected and can edit.");
  });
});

describe("the Updates section in German", () => {
  it("names its controls and offers the periods in German", async () => {
    await setLanguage("de");
    h.choose.mockResolvedValue("cancel");
    const w = mount(UpdatesSection, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain("Kanal");
    expect(w.text()).toContain("Automatisch nach Updates suchen");
    await w.get("#prefs-update-period").trigger("click");
    await flushPromises();
    const rows = [...document.body.querySelectorAll<HTMLElement>(".opt-row")].map((r) => r.textContent?.trim());
    expect(rows).toContain("Täglich");
  });
});
