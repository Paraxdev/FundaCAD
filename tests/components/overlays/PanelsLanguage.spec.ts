// The tool panels read in the chosen language and follow a switch made while they are open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PropertiesPanel from "../../../src/components/overlays/PropertiesPanel.vue";
import OverhangPanel from "../../../src/components/overlays/OverhangPanel.vue";
import InterferencePanel from "../../../src/components/overlays/InterferencePanel.vue";
import MeasureReadout from "../../../src/components/overlays/MeasureReadout.vue";
import MirrorToolPanel from "../../../src/components/overlays/MirrorToolPanel.vue";
import TextToolPanel from "../../../src/components/overlays/TextToolPanel.vue";
import TargetEditPanel from "../../../src/components/overlays/TargetEditPanel.vue";
import ProjectFilterBar from "../../../src/components/overlays/ProjectFilterBar.vue";
import AreaFilterChip from "../../../src/components/overlays/AreaFilterChip.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import { setLanguage } from "../../../src/i18n";
import { usePanelsStore } from "../../../src/stores/panels";
import { useToolPanelStore, type MirrorPanelView } from "../../../src/stores/toolPanels";
import { TextPanel } from "../../../src/sketch/textPanel";

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(async () => {
  await setLanguage("system");
  localStorage.clear();
});

const $ = (sel: string) => document.body.querySelector<HTMLElement>(sel);
const $$ = (sel: string) => [...document.body.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => $(sel)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const texts = (sel: string) => $$(sel).map((e) => e.textContent?.replace(/\s+/g, " ").trim());

async function switchTo(code: "de" | "ja") {
  await setLanguage(code);
  await flushPromises();
}

function withEngine(engine: object) {
  return { global: { provide: { [ENGINE as symbol]: engine as Engine } }, attachTo: document.body };
}

describe("the Properties panel", () => {
  async function open() {
    mount(PropertiesPanel, withEngine({ ui: { panels: { closeProperties: () => {} } } }));
    usePanelsStore().showProperties({
      title: "Gehäuse",
      rows: [{ k: "Volume", v: "1000 mm³" }],
      raw: { volumeMm3: 1000, areaMm2: 600 },
      faults: [],
    });
    await flushPromises();
  }

  it("reads its title, rows and hint in German, then in Japanese after a switch", async () => {
    await switchTo("de");
    await open();
    expect(text(".properties-panel .ui-panel-title")).toBe("Eigenschaften, Gehäuse");
    expect(texts(".properties-panel .measure-k")).toEqual(
      expect.arrayContaining(["Material", "Füllung", "Wandstärke", "Masse, geschätzt", "Filament, 1,75 mm"]),
    );
    expect(text(".properties-panel")).toContain("Esc schließt");

    await switchTo("ja");
    expect(text(".properties-panel .ui-panel-title")).toBe("Gehäuse のプロパティ");
    expect(texts(".properties-panel .measure-k")).toEqual(expect.arrayContaining(["インフィル", "質量 (推定)"]));
  });

  it("says why a body has no mass in the language", async () => {
    await switchTo("de");
    mount(PropertiesPanel, withEngine({ ui: { panels: { closeProperties: () => {} } } }));
    usePanelsStore().showProperties({ title: "Gehäuse", rows: [], raw: null, faults: ["offen"] });
    await flushPromises();
    expect(text(".properties-panel")).toContain("Kein einwandfreier Volumenkörper, daher weder Volumen noch Masse:");
  });
});

describe("the Overhang panel", () => {
  it("names its controls and legend in German, and the legend follows a switch to Japanese", async () => {
    await switchTo("de");
    mount(
      OverhangPanel,
      withEngine({ viewport: { draftConfig: { dir: "+Z", threshold: 45 }, setDraftConfig: () => {} } }),
    );
    usePanelsStore().overhang = true;
    await flushPromises();
    expect(text(".overhang-panel .ui-panel-title")).toBe("Überhanganalyse");
    expect(text(".overhang-panel .ui-panel-hint")).toContain("Erneut Überhang schließt");
    expect(texts(".overhang-legend")).toEqual([
      "Überhang, braucht Stützstruktur",
      "Wand oder steile Unterseite, druckt ohne Stützen",
      "Zeigt nach oben",
    ]);

    await switchTo("ja");
    expect(texts(".overhang-legend")).toEqual([
      "オーバーハング、サポートが必要",
      "壁または急な下面、そのまま印刷できます",
      "上向き",
    ]);
    expect(text(".overhang-panel .ui-panel-hint")).toContain("もう一度 オーバーハング で閉じる");
  });
});

describe("the Interference panel", () => {
  it("reads its empty result, lists and hints in German, then Japanese", async () => {
    await switchTo("de");
    mount(
      InterferencePanel,
      withEngine({
        ui: { panels: { closeInterference: () => {}, showInterference: async () => {} } },
        viewport: { policy: "faces", setSelectedBodies: () => {}, setSelectPolicy: () => {} },
      }),
    );
    usePanelsStore().showInterference({ title: "Kollision", clashes: [], clearances: [], unchecked: ["Netz"] });
    await flushPromises();
    expect($(".clash-list")?.getAttribute("aria-label")).toBe("Kollisionen");
    expect(text(".ui-panel")).toContain("Keine Überlappung unter den geprüften Paaren");
    expect(text(".ui-panel")).toContain("Nicht geprüft: Netz");
    expect(text(".ui-panel")).toContain("Abstandsprüfung");

    await switchTo("ja");
    expect($(".clash-list")?.getAttribute("aria-label")).toBe("干渉");
    expect(text(".ui-panel")).toContain("確認したペアに重なりはありません");
    expect(text(".ui-panel")).toContain("Esc で閉じる");
  });
});

describe("the Measure readout", () => {
  it("names the tool and its exit key in German, then Japanese", async () => {
    await switchTo("de");
    mount(MeasureReadout, { attachTo: document.body });
    useToolPanelStore().measure = [{ k: "", v: "Klicken Sie auf eine Fläche" }];
    await flushPromises();
    expect(text(".ui-panel-title")).toBe("Messen");
    expect(text(".ui-panel-hint")).toBe("Esc beendet");

    await switchTo("ja");
    expect([text(".ui-panel-title"), text(".ui-panel-hint")]).toEqual(["計測", "Esc で終了"]);
  });
});

describe("the Mirror panel", () => {
  function viewOf(over: Partial<MirrorPanelView> = {}): MirrorPanelView {
    return {
      id: 1,
      fields: [
        { key: "objects", label: "Objekte", items: ["Linie 1"], value: "1 Objekt", filled: true },
        { key: "line", label: "Spiegellinie", items: [], value: "", filled: false },
      ],
      active: "line",
      planes: [],
      plane: null,
      ready: false,
      onActivate: vi.fn(),
      onClear: vi.fn(),
      onRemove: vi.fn(),
      onPlane: vi.fn(),
      onCommit: vi.fn(),
      onCancel: vi.fn(),
      ...over,
    };
  }

  it("reads its buttons, lists and the reason it waits in German, then Japanese", async () => {
    await switchTo("de");
    mount(MirrorToolPanel, { props: { view: viewOf() }, attachTo: document.body });
    await nextTick();
    expect($(".mirror-panel")?.getAttribute("aria-label")).toBe("Auswahl spiegeln");
    expect(text(".tgt-title")).toBe("Spiegeln");
    expect(text(".tgt-done")).toBe("Spiegeln");
    expect($(".tgt-done")?.title).toBe("Wählen Sie zuerst die Spiegellinie");
    expect(text(".tgt-cancel")).toBe("Abbrechen");
    expect(texts(".tgt-clear")).toEqual(["Alle entfernen", "Alle entfernen"]);
    expect($(".tgt-remove")?.title).toBe("Linie 1 entfernen");
    expect(text('[data-field="line"] .tgt-none')).toBe("Zum Festlegen klicken");
    expect(text(".tgt-hint")).toContain("Umschalt fügt zu den Objekten hinzu");

    await switchTo("ja");
    expect($(".tgt-done")?.title).toBe("先にミラーの線を選んでください");
    expect(texts(".tgt-clear")).toEqual(["すべて外す", "すべて外す"]);
    expect(text(".tgt-cancel")).toBe("キャンセル");
  });

  it("says plane in the 3D tool, which offers base plane chips", async () => {
    await switchTo("de");
    const [objects, line] = viewOf().fields;
    const view = viewOf({ planes: ["XY", "XZ", "YZ"], fields: [{ ...objects, filled: false, items: [] }, line] });
    mount(MirrorToolPanel, { props: { view }, attachTo: document.body });
    await nextTick();
    expect($(".tgt-done")?.title).toBe("Wählen Sie zuerst Objekte und die Spiegelebene");
    expect($('.mirror-chips [role="radiogroup"]')?.getAttribute("aria-label")).toBe("Spiegelebene");
  });
});

describe("the sketch Text panel", () => {
  it("labels its fields and alignments in German, and the alignments follow a switch", async () => {
    await switchTo("de");
    const handlers = { onCommit: vi.fn(), onCancel: vi.fn(), onChange: vi.fn() };
    new TextPanel().show({ x: 40, y: 60 }, ["Arial"], {}, handlers);
    mount(TextToolPanel, { props: { req: useToolPanelStore().text! }, attachTo: document.body });
    await nextTick();
    expect($(".text-tool-text textarea")?.getAttribute("placeholder")).toBe("Text…");
    expect(texts(".text-tool-label")).toEqual(["Größe", "Winkel°", "Rahmenbreite (mm)"]);
    expect(texts('.text-tool-panel [role="radio"]')).toEqual(["Links", "Zentriert", "Rechts"]);
    expect(text(".text-tool-add")).toBe("Hinzufügen");
    expect($(".text-tool-cancel")?.getAttribute("aria-label")).toBe("Abbrechen");

    await switchTo("ja");
    expect(texts('.text-tool-panel [role="radio"]')).toEqual(["左", "中央", "右"]);
    expect(text(".text-tool-add")).toBe("追加");
  });
});

describe("the selection editor", () => {
  it("reads Done, Cancel and its empty list in German, then Japanese", async () => {
    await switchTo("de");
    const tool = {
      active: true,
      editingId: "f1",
      field: { field: "faces", label: "Flächen", kind: "face", shape: "set", arity: "many" },
      rows: () => [],
      onChange: () => () => {},
      hoverAt: () => {},
    };
    mount(
      TargetEditPanel,
      withEngine({
        tools: { targetEdit: tool },
        store: { document: { features: [{ id: "f1", type: "fillet", name: "Rundung" }] } },
      }),
    );
    await nextTick();
    expect($(".tgt-panel")?.getAttribute("aria-label")).toBe("Auswahl für Rundung");
    expect([text(".tgt-done"), text(".tgt-cancel")]).toEqual(["Fertig", "Abbrechen"]);
    expect(text(".tgt-none")).toBe("Klicken Sie auf Geometrie, um sie hinzuzufügen");
    expect($(".tgt-clear")?.title).toBe("Alle Einträge entfernen");

    await switchTo("ja");
    expect([text(".tgt-done"), text(".tgt-none")]).toEqual(["完了", "ジオメトリをクリックして追加"]);
  });
});

describe("the Project filter bar", () => {
  it("names its chips' group in German, then Japanese", async () => {
    await switchTo("de");
    mount(ProjectFilterBar, { attachTo: document.body });
    await nextTick();
    const group = () => $('.project-filter-bar [role="radiogroup"]')?.getAttribute("aria-label");
    expect(group()).toBe("Projektionsfilter");
    await switchTo("ja");
    expect(group()).toBe("投影フィルター");
  });
});

describe("the area selection chip", () => {
  it("says what the box takes and how in German, then Japanese", async () => {
    await switchTo("de");
    const drag = { rect: { x0: 0, y0: 0, x1: 40, y1: 40 }, mode: "window", from: { x: 0, y: 0 }, at: { x: 40, y: 40 } };
    mount(AreaFilterChip, withEngine({ viewport: { areaDragState: drag, areaTakes: "profiles" } }));
    window.dispatchEvent(new PointerEvent("pointerdown", { button: 0 }));
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    await new Promise((r) => setTimeout(r, 0));
    expect([text(".areachip-what"), text(".areachip-how")]).toEqual(["Skizzenprofile", "ganz innerhalb"]);
    await switchTo("ja");
    expect([text(".areachip-what"), text(".areachip-how")]).toEqual(["スケッチプロファイル", "完全に内側"]);
  });
});
