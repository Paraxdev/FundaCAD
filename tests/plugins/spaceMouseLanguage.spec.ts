// The 3D mouse panel, its axis and action names, its settings and its blocked message follow the chosen language.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";

const invoke = vi.fn(async (..._a: unknown[]): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

// happy-dom has no WebGL, and the test cube is not what these cases are about.
vi.mock("three", async (importOriginal) => ({
  ...(await importOriginal<typeof import("three")>()),
  WebGLRenderer: class {
    setPixelRatio() {}
    setSize() {}
    render() {}
    forceContextLoss() {}
    dispose() {}
  },
}));

import SpaceMouseSection from "../../plugins/FundaCAD.SpaceMouse/SpaceMouseSection.vue";
import { ACTION_LABELS, AXIS_LABELS, SETTINGS, blockedText } from "../../plugins/FundaCAD.SpaceMouse/spacemouse";
import { setLanguage } from "../../src/i18n";
import { stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(() => {
  document.body.innerHTML = "";
  stubResizeObserver(vi.stubGlobal);
});
afterEach(async () => {
  invoke.mockReset();
  vi.unstubAllGlobals();
  await setLanguage("system");
});

const prop = (key: string) => SETTINGS.props.find((p) => p.key === key) as unknown as Record<string, unknown>;

describe("the 3D mouse panel", () => {
  it("reads in German, then in Japanese, without a remount", async () => {
    invoke.mockImplementation(async (cmd) => (cmd === "spacemouse_flatpak_hint" ? "run spacenavd" : null));
    await setLanguage("de");
    const w = mount(SpaceMouseSection, { attachTo: document.body });
    await flushPromises();
    expect(w.text()).toContain("Live-Achsen");
    expect(w.text()).toContain("Achsenzuordnung");
    expect(w.text()).toContain("Schieben ←→ (Tx)");
    expect(w.find('[data-testid="spacemouse-flatpak-hint"]').text()).toBe(
      "Damit das Flatpak eine 3D-Maus erreicht, run spacenavd",
    );
    expect(w.find("canvas").attributes("aria-label")).toContain("Testwürfel");
    expect(w.find(".sm-map-row .sr-only").text()).toBe("Verschieben ←→");

    await setLanguage("ja");
    await nextTick();
    expect(w.text()).toContain("軸の割り当て");
    expect(w.text()).toContain("スライド ←→ (Tx)");
    expect(w.find(".sm-map-row .sr-only").text()).toBe("パン ←→");
  });
});

describe("the lists, settings and refusal read the language when asked", () => {
  it("rename axes, actions and settings after a switch", async () => {
    await setLanguage("de");
    expect(AXIS_LABELS.tz).toBe("Heben ↑↓ (Tz)");
    expect(ACTION_LABELS.orbitAz).toBe("Drehen ←→");
    expect(prop("deadzone").label).toBe("Totzone");
    expect(prop("deadzone").group).toBe("Empfindlichkeit");
    expect((prop("mode").options as { label: string }[]).map((o) => o.label)).toEqual(["Objektmodus", "Kameramodus"]);
    await setLanguage("ja");
    expect(AXIS_LABELS.tz).toBe("上下 ↑↓ (Tz)");
    expect(prop("panPercent").label).toBe("パン");
    expect(prop("deadzone").group).toBe("感度");
    await setLanguage("en");
    expect(AXIS_LABELS.tz).toBe("Lift ↑↓ (Tz)");
  });

  it("words the blocked device message in the chosen language", async () => {
    const b = { name: "SpaceMouse Pro", detail: "EACCES", hint: null };
    await setLanguage("de");
    expect(blockedText(b)).toBe(
      "„SpaceMouse Pro“ wurde gefunden, kann aber nicht gelesen werden, starten Sie spacenavd oder installieren Sie die udev-Regel. Lesen Sie dazu die Seite zur 3D-Maus im Handbuch.",
    );
    await setLanguage("en");
    expect(blockedText({ ...b, hint: "do this" })).toBe(
      'Found "SpaceMouse Pro" but can\'t read it, do this. See the 3D mouse page of the manual.',
    );
  });
});
