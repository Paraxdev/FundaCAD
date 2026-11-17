// The Render dock's tabs, its Materials and Camera tabs and the surface node editor read in the chosen language, and
// their lists follow a switch made while they are open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import RenderDock from "../../../src/components/shell/RenderDock.vue";
import SurfaceNodeEditor from "../../../src/components/shell/SurfaceNodeEditor.vue";
import { ENGINE } from "../../../src/app/engineKey";
import { setWorkspace } from "../../../src/ui/workspace";
import { setLanguage } from "../../../src/i18n";
import type { MaterialDef } from "../../../src/document/materials";
import type { Engine } from "../../../src/app/engine";

vi.mock("../../../src/viewport/materialPreview", () => ({
  materialPreview: () => null,
  onPreviewsChanged: () => () => {},
}));

const LIBRARY: MaterialDef[] = [
  { id: "m-glass", name: "Glass", color: "#cfe4ee", metalness: 0, roughness: 0.05, opacity: 0.25 },
  { id: "m-gold", name: "Gold", color: "#d4af37", metalness: 1, roughness: 0.3 },
];

const engine = {
  store: {
    materialLibrary: LIBRARY,
    bodyMaterialId: () => undefined,
    faceMaterialId: () => undefined,
    faceMaterialEntries: () => [],
    updateMaterial: vi.fn(),
    buildState: { building: false, result: { bodies: [] } },
    onReferenceImagesChange: () => () => {},
  },
  bridge: { buildVersion: ref(0) },
  viewport: {
    getSelectedFaceIds: () => [],
    tracedPictureSize: () => null,
    qualityTier: () => ({ lowPower: false, auto: false, software: false }),
    onRenderTierChange: () => () => {},
  },
  tools: {},
  canvas: { getBoundingClientRect: () => ({ width: 100, height: 100 }) },
} as unknown as Engine;

let w: VueWrapper;
const texts = (sel: string) => w.findAll(sel).map((e) => e.text().replace(/\s+/g, " ").trim());
const tabBody = (tab: string) => w.findAll(".rd-scroll")[["material", "environment", "camera"].indexOf(tab)]!;

async function switchTo(lang: "de" | "ja") {
  await setLanguage(lang);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  setWorkspace("render");
});
afterEach(async () => {
  w?.unmount();
  setWorkspace("model");
  await setLanguage("system");
});

describe("the Render dock in another language", () => {
  it("names its tabs and reads the Camera tab in German, then follows a switch to Japanese", async () => {
    await switchTo("de");
    w = mount(RenderDock, { global: { provide: { [ENGINE as symbol]: engine } } });
    await flushPromises();
    expect(texts("[role=tab]")).toEqual(["Material", "Umgebung", "Kamera"]);
    const camera = tabBody("camera").text();
    for (const line of ["Objektiv", "Sichtfeld", "Schärfentiefe", "Unschärfe", "Blende", "Kantenlinien"]) {
      expect(camera).toContain(line);
    }
    expect(camera).not.toMatch(/Field of view|Depth of field|Edge lines/);
    expect(tabBody("camera").find('[aria-label="Rendergröße"]').exists()).toBe(true);

    await switchTo("ja");
    expect(texts("[role=tab]")).toEqual(["材料", "環境", "カメラ"]);
    expect(tabBody("camera").text()).toContain("被写界深度");
  });

  it("reads the Materials tab and a picked glass material's lists in German, then in Japanese", async () => {
    await switchTo("de");
    w = mount(RenderDock, { global: { provide: { [ENGINE as symbol]: engine } } });
    await flushPromises();
    const materials = tabBody("material");
    expect(materials.text()).toContain("Bibliothek");
    expect(w.get("#rd-material-search").attributes("placeholder")).toBe("Materialien suchen");
    expect(w.get('.rd-tile[data-material="m-gold"] .rd-sub').text()).toMatch(/metallisch/);

    await w.get('.rd-tile[data-material="m-glass"]').trigger("click");
    await nextTick();
    expect(texts("[data-ior]")).toEqual(["Wasser", "Glas", "Kristall", "Diamant"]);
    expect(texts("[data-surface]")).toEqual(["Keine", "Rauschen", "Kratzer", "Gebürstet", "Abnutzung", "Streifen"]);
    expect(texts("[data-advanced] .prefs-label")).toEqual(["Erweitert", "Samtglanz", "Anisotropie", "Streuung (mm)"]);
    expect(materials.find('[role=group][aria-label="Brechungsindex"]').exists()).toBe(true);

    await switchTo("ja");
    expect(texts("[data-ior]")).toEqual(["水", "ガラス", "クリスタル", "ダイヤモンド"]);
    expect(texts("[data-surface]")).toEqual(["なし", "ノイズ", "傷", "ヘアライン", "摩耗", "縞"]);
    expect(texts("[data-advanced] .prefs-label")).toEqual(["詳細設定", "シーン", "異方性", "散乱（mm）"]);
    expect(w.get('.rd-tile[data-material="m-gold"] .rd-sub').text()).toMatch(/メタリック/);
  });
});

describe("the surface node editor in another language", () => {
  it("names its nodes and its Shift+A groups in German, and the groups follow a switch to Japanese", async () => {
    await switchTo("de");
    w = mount(SurfaceNodeEditor, {
      attachTo: document.body,
      props: { materialId: "m-glass" },
      global: { provide: { [ENGINE as symbol]: engine } },
    });
    await flushPromises();
    expect(w.get(".ne-title-main").text()).toBe("Oberflächengraph · Glass");
    expect(w.get('[data-add="noise"]').text()).toBe("+ Rauschen");
    expect(w.get('[data-add="colorramp"]').text()).toBe("+ Farbverlauf");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "A", shiftKey: true }));
    await nextTick();
    expect(w.get(".ne-addhead").text()).toBe("Hinzufügen");
    expect(texts(".ne-addgrp-label")).toEqual(["Textur", "Eingabe", "Farbe", "Konverter"]);

    await switchTo("ja");
    expect(texts(".ne-addgrp-label")).toEqual(["テクスチャ", "入力", "カラー", "コンバーター"]);
    expect(w.get('[data-add-menu="math"]').text()).toBe("数式");
  });
});
