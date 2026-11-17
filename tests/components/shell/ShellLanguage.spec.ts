// The view controls, the workspace toggle, the section chip and the versions panel read in the chosen language, and
// their lists follow a switch made while they are open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ViewportControls from "../../../src/components/shell/ViewportControls.vue";
import WorkspaceToggle from "../../../src/components/shell/WorkspaceToggle.vue";
import SectionChip from "../../../src/components/shell/SectionChip.vue";
import VersionsPanel from "../../../src/components/shell/VersionsPanel.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { resetPathTracedOverride } from "../../../src/ui/viewMode";
import { setInputModalityForTest } from "../../../src/ui/inputModality";
import { setWorkspace } from "../../../src/ui/workspace";
import { setLanguage } from "../../../src/i18n";
import { freshStore } from "../../document/storeKit";

enableAutoUnmount(afterEach);

const texts = (sel: string) =>
  [...document.querySelectorAll<HTMLElement>(sel)].map((e) => e.textContent!.replace(/\s+/g, " ").trim());
const pop = () => document.querySelector<HTMLElement>(".vc-pop")!.textContent!.replace(/\s+/g, " ");

async function switchTo(lang: "de" | "ja") {
  await setLanguage(lang);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  resetPathTracedOverride();
  setInputModalityForTest("pointer");
  setWorkspace("model");
});
afterEach(async () => {
  setWorkspace("model");
  await setLanguage("system");
});

async function controls() {
  const engine = {
    canvas: document.createElement("canvas"),
    handleAction: vi.fn(),
    viewport: {
      renderTier: { lowPower: false, auto: false, webgpu: true },
      projection: "persp",
      onRenderTierChange: () => () => {},
      setViewCubeInset: () => {},
      setStandardView: vi.fn(),
    },
    store: { buildState: {}, fileName: "Untitled", dirty: false, document: {} },
    bridge: { buildVersion: ref(0), metaVersion: ref(0), docVersion: ref(0) },
  } as unknown as Engine;
  const w = mount(ViewportControls, {
    global: { provide: { [ENGINE as symbol]: engine }, stubs: { VersionsPanel: true } },
    attachTo: document.body,
  });
  // Vue skips a listener for an event stamped in the same millisecond it was attached, once another listener ran.
  await new Promise((r) => setTimeout(r, 2));
  return w;
}
const opener = (w: VueWrapper, icon: string) => w.get(`[data-icon="${icon}"]`).element.closest("button")!;

describe("the view controls in another language", () => {
  it("name the view modes and the Views list in German, and the list follows a switch to Japanese", async () => {
    await switchTo("de");
    const w = await controls();
    expect(w.get('[data-view-mode="realtime"]').attributes("aria-label")).toBe("Echtzeit (Z)");
    expect(w.get('[data-view-mode="pathtraced"]').attributes("aria-label")).toBe("Pfadverfolgung (Z)");
    expect(opener(w, "views").getAttribute("aria-label")).toBe("Ansichten");

    opener(w, "views").click();
    await nextTick();
    expect(texts(".vc-pop .ui-list-row")).toEqual([
      "Draufsicht",
      "Untersicht",
      "Vorderansicht",
      "Rückansicht",
      "Rechte Seitenansicht",
      "Linke Seitenansicht",
    ]);
    expect(texts(".vc-pop .vc-pop-btn")).toEqual(["Standardansicht", "Auf Modell einpassen"]);

    await switchTo("ja");
    expect(texts(".vc-pop .ui-list-row")).toEqual(["平面図", "底面図", "正面図", "背面図", "右側面図", "左側面図"]);
    expect(texts(".vc-pop .vc-pop-btn")).toEqual(["既定のビュー", "モデル全体を表示"]);
    expect(w.get('[data-view-mode="realtime"]').attributes("aria-label")).toBe("リアルタイム (Z)");
  });

  it("read the Display card's overlays in German, then in Japanese", async () => {
    await switchTo("de");
    const w = await controls();
    opener(w, "shaded").click();
    await nextTick();
    for (const line of [
      "Schattierung",
      "Einblendungen anzeigen",
      "Kantenumrisse",
      "Referenzbilder",
      "Flächenanalyse",
    ]) {
      expect(pop()).toContain(line);
    }
    expect(pop()).not.toMatch(/Edge outlines|Surface analysis|Show overlays/);

    await switchTo("ja");
    expect(pop()).toContain("エッジの輪郭");
    expect(pop()).toContain("サーフェス解析");
  });

  it("read the Grid card's units in Japanese, and the list follows a switch to German", async () => {
    await switchTo("ja");
    const w = await controls();
    await w.get(".grid-btn").trigger("click");
    await nextTick();
    expect(texts(".vc-pop .opt-label")).toEqual(["ミリメートル", "センチメートル", "インチ"]);
    await switchTo("de");
    expect(texts(".vc-pop .opt-label")).toEqual(["Millimeter", "Zentimeter", "Zoll"]);
    expect(w.get(".grid-btn").attributes("title")).toBe("Raster und Einheiten");
  });
});

describe("the workspace toggle in another language", () => {
  it("names its group, options and tips in German, and follows a switch to Japanese", async () => {
    await switchTo("de");
    const w = mount(WorkspaceToggle, { attachTo: document.body });
    await flushPromises();
    const radios = () => w.findAll('[role="radio"]');
    expect(w.get("#workspace-toggle").attributes("aria-label")).toBe("Arbeitsbereich");
    expect(radios().map((r) => [r.attributes("data-workspace"), r.text()])).toEqual([
      ["model", "Modell"],
      ["render", "Rendern"],
    ]);
    expect(radios()[1]!.attributes("title")).toBe("Rendern: Materialien, Umgebung und Kamera");

    await switchTo("ja");
    expect(radios().map((r) => r.text())).toEqual(["モデル", "レンダリング"]);
    expect(radios()[0]!.attributes("title")).toBe("モデル：全幅、すべてのツール");
  });
});

describe("the section chip in another language", () => {
  it("names itself and its buttons in German, then in Japanese", async () => {
    const section = {
      phase: "on",
      onChange(fn: (p: string) => void) {
        fn("on");
        return () => {};
      },
    };
    const engine = {
      tools: { section },
      store: { onDocChange: () => () => {}, onBuild: () => () => {} },
      toolOwnsScreen: () => false,
      toolBusy: () => false,
    } as unknown as Engine;
    await switchTo("de");
    const w = mount(SectionChip, { global: { provide: { [ENGINE as symbol]: engine } } });
    const chip = () => w.get('[data-testid="section-chip"]');
    expect(chip().attributes("aria-label")).toBe("Schnittansicht");
    expect(chip().text()).toContain("Schnitt an");
    expect(w.findAll("button").map((b) => b.text())).toEqual(["Bearbeiten", "Umkehren", "Aus"]);

    await switchTo("ja");
    expect(w.findAll("button").map((b) => b.text())).toEqual(["編集", "反転", "オフ"]);
    expect(chip().attributes("aria-label")).toBe("断面表示");
  });
});

describe("the versions panel in another language", () => {
  it("reads its empty note, message field and Save in German, then in Japanese", async () => {
    const store = freshStore();
    store.load(JSON.stringify({ parameters: {}, features: [] }));
    const engine = {
      store,
      bridge: { docVersion: ref(0), metaVersion: ref(0), buildVersion: ref(0) },
    } as unknown as Engine;
    await switchTo("de");
    const w = mount(VersionsPanel, { attachTo: document.body, global: { provide: { [ENGINE as symbol]: engine } } });
    await flushPromises();
    expect(w.get(".versions-head .pop-section").text()).toBe("Versionen");
    expect(w.get(".pop-note").text()).toBe(
      "Noch keine Versionen. Speichern Sie eine, um zu diesem Stand zurückkehren zu können.",
    );
    expect(w.get(".versions-save input").attributes("placeholder")).toBe("Was hat sich geändert");
    expect(w.get(".versions-save-btn").text()).toBe("Version speichern");

    await switchTo("ja");
    expect(w.get(".pop-note").text()).toBe("バージョンはまだありません。保存しておくと、この時点に戻れます。");
    expect(w.get(".versions-save-btn").text()).toBe("バージョンを保存");
  });
});
