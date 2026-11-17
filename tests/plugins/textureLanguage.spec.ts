// The Texture plugin speaks the chosen language through its own lines: the panel, the pickers, the value rows and the
// tool's summary. Pattern names stay values, only the labels shown for them change.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import TextureToolPanel from "../../plugins/FundaCAD.Texture/TextureToolPanel.vue";
import * as panel from "../../plugins/FundaCAD.Texture/panel";
import { TextureTool } from "../../plugins/FundaCAD.Texture/textureTool";
import {
  TEXTURE_CHOICE_FIELDS,
  TEXTURE_FILE_FIELDS,
  TEXTURE_KINDS,
  TEXTURE_KIND_GROUPS,
  TEXTURE_TARGETS,
  sharpnessLabel,
  textureNumFields,
} from "../../plugins/FundaCAD.Texture/textureForm";
import { activate } from "../../plugins/FundaCAD.Texture/main";
import { reloadLanguageFiles, setLanguage } from "../../src/i18n";
import { resetContributions } from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";
import type { DocumentStore, Viewport } from "../../src/plugins/host";
import { featureEnglish, featureMeta } from "../../src/ui/featureMeta";

enableAutoUnmount(afterEach);

const labels = (rows: readonly { label: string }[]) => rows.map((r) => r.label);
const rowLabels = () => [...document.querySelectorAll<HTMLElement>("label")].map((l) => l.textContent);
const optionTexts = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim() ?? "");

function openPanel(palette: { name: string; color: string }[] = []) {
  const wrapper = mount(TextureToolPanel, { attachTo: document.body });
  panel.show(
    { editing: false, mode: "faces", initial: {}, palette },
    { onCommit: vi.fn(), onCancel: vi.fn(), onChange: vi.fn(), onModeChange: vi.fn() },
  );
  return wrapper;
}

beforeEach(async () => {
  setActivePinia(createPinia());
  panel.resetPanel();
  document.body.innerHTML = "";
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  await setLanguage("en");
});

afterEach(async () => {
  panel.resetPanel();
  resetContributions();
  vi.unstubAllGlobals();
  await reloadLanguageFiles();
  await setLanguage("system");
});

describe("the Texture pickers and value rows follow the language", () => {
  it("keeps the saved pattern values while the labels change", async () => {
    const values = TEXTURE_KINDS.map((k) => k.value);
    expect(labels(TEXTURE_KINDS).slice(0, 3)).toEqual(["Knurl", "Hex", "Waves"]);

    await setLanguage("de");
    expect(labels(TEXTURE_KINDS).slice(0, 3)).toEqual(["Rändel", "Sechseck", "Wellen"]);
    expect(labels(TEXTURE_KIND_GROUPS)).toEqual(["Geometrisch", "Organisch", "Funktional", "Bild"]);

    await setLanguage("ja");
    expect(labels(TEXTURE_KINDS).slice(0, 3)).toEqual(["ローレット", "六角", "波"]);
    expect(TEXTURE_KINDS.map((k) => k.value)).toEqual(values);
  });

  it("reads the choice, toggle, target and file rows in the new language", async () => {
    const find = (field: string) => TEXTURE_CHOICE_FIELDS.find((f) => f.field === field)!;
    expect(find("direction").label).toBe("Direction");

    await setLanguage("de");
    expect(find("kind").label).toBe("Muster");
    expect(find("direction").label).toBe("Richtung");
    expect(labels(find("direction").options)).toEqual(["Erhaben", "Vertieft", "Symmetrisch"]);
    expect(find("direction").options.map((o) => o.value)).toEqual(["out", "in", "both"]);
    expect(TEXTURE_TARGETS[0]!.label).toBe("Flächen");
    expect(TEXTURE_TARGETS[0]!.whenEmpty).toBe("der ganze Körper");
    expect(TEXTURE_FILE_FIELDS[0]!.label).toBe("Höhenkarte");
    expect(TEXTURE_FILE_FIELDS[0]!.filters![0]!.name).toBe("Bilder");

    await setLanguage("ja");
    expect(find("direction").label).toBe("方向");
    expect(labels(find("projection").options)).toEqual(["3平面", "ボックス", "平面投影"]);
  });

  it("builds the numeric rows and the shape label fresh in each language", async () => {
    expect(textureNumFields()[0]).toEqual(["depth", "Depth", "length"]);
    expect(sharpnessLabel("facet").text).toBe("Land");

    await setLanguage("de");
    expect(textureNumFields()[0]).toEqual(["depth", "Tiefe", "length"]);
    expect(textureNumFields().map((r) => r[0])).toContain("boundaryInset");
    expect(sharpnessLabel("round").text).toBe("Schärfe");

    await setLanguage("ja");
    expect(textureNumFields()[0]).toEqual(["depth", "深さ", "length"]);
    expect(sharpnessLabel("facet").text).toBe("平坦部");
  });
});

describe("the Texture panel follows the language", () => {
  it("relabels its rows and buttons after a switch, in German and Japanese", async () => {
    openPanel();
    await nextTick();
    expect(rowLabels()).toContain("Depth");
    expect(document.body.textContent).toContain("Add");

    await setLanguage("de");
    await nextTick();
    expect(rowLabels()).toContain("Tiefe");
    expect(rowLabels()).toContain("Richtung");
    expect(document.body.textContent).toContain("Hinzufügen");
    expect(document.body.textContent).toContain("Abbrechen");
    expect(document.body.textContent).not.toContain("Cancel");

    await setLanguage("ja");
    await nextTick();
    expect(rowLabels()).toContain("深さ");
    expect(document.body.textContent).toContain("追加");
    expect(document.body.textContent).toContain("キャンセル");
  });

  it("lists the patterns and the print colour slots in the chosen language", async () => {
    await setLanguage("de");
    openPanel([{ name: "Rot", color: "#f00" }]);
    await nextTick();
    const kind = [...document.querySelectorAll<HTMLElement>("[role=combobox]")].find((el) =>
      (el.getAttribute("aria-label") ?? "").startsWith("Muster"),
    )!;
    kind.click();
    await flushPromises();
    expect(optionTexts().some((o) => o.startsWith("Rändel"))).toBe(true);
    expect(optionTexts().some((o) => o.startsWith("Perlin-Rauschen"))).toBe(true);
    kind.click();
    await flushPromises();

    const color = [...document.querySelectorAll<HTMLElement>("[role=combobox]")].find((el) =>
      (el.getAttribute("aria-label") ?? "").startsWith("Druckfarbe"),
    )!;
    color.click();
    await flushPromises();
    expect(optionTexts()).toEqual(["Körperfarbe", "Rot (Slot 1)"]);
  });
});

function fakeViewport() {
  const state = { faceIds: [] as number[], bodyIds: [] as string[] };
  const vp = {
    selecting: "faces",
    setSelectionMode: () => {},
    getSelectedFaceIds: () => [...state.faceIds],
    getSelectedBodies: () => [...state.bodyIds],
    selectFaces: () => {},
    setSelectedBodies: () => {},
    clearSelection: () => {},
    selectedFacesForPressPull: () => null,
  };
  return { vp: vp as unknown as Viewport, state };
}

function fakeStore() {
  const store = {
    document: { features: [] },
    buildState: { result: { bodies: [{ id: "body1", name: "Body 1" }] } },
    nextId: () => "new1",
    bodyName: () => "Body 1",
    onBuild: () => () => {},
    setPreview: () => {},
  };
  return store as unknown as DocumentStore;
}

describe("the Texture tool's summary follows the language", () => {
  it("counts faces with the language's plural and names the body", async () => {
    await setLanguage("de");
    const { vp, state } = fakeViewport();
    const tool = new TextureTool(vp, fakeStore());
    tool.start(() => {});
    expect(panel.summary.value).toBe("Keine Flächen gewählt, klicken Sie eine oder mehrere Flächen an");

    state.faceIds = [3];
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(panel.summary.value).toBe("1 Fläche gewählt");
    state.faceIds = [3, 4];
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(panel.summary.value).toBe("2 Flächen gewählt");
    tool.cancel();

    await setLanguage("ja");
    tool.start(() => {});
    state.faceIds = [1, 2, 3];
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(panel.summary.value).toBe("3個の面を選択中");
    tool.cancel();
  });

  it("words the line again when the language changes with the tool open", async () => {
    const { vp, state } = fakeViewport();
    const tool = new TextureTool(vp, fakeStore());
    tool.start(() => {});
    state.faceIds = [3, 4];
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(panel.summary.value).toBe("2 faces selected");

    await setLanguage("de");
    expect(panel.summary.value).toBe("2 Flächen gewählt");
    await setLanguage("ja");
    expect(panel.summary.value).toBe("2個の面を選択中");
    tool.cancel();
  });
});

describe("the Texture step keeps its English name", () => {
  it("names the feature Texture for English paths whatever the language", async () => {
    const stop = await activate({ viewport: {}, store: {}, geometry: {} } as unknown as Engine);
    await setLanguage("de");
    expect(featureMeta({ type: "texture" }).label).toBe("Textur");
    expect(featureEnglish({ type: "texture" })).toBe("Texture");
    stop();
  });
});
