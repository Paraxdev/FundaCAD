// The Reference images plugin speaks the chosen language through its own lines: the settings panel, the calibration
// prompts, the browser folder, and the toasts and prompts of the tool.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick, ref } from "vue";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

import ImagePanel from "../../plugins/FundaCAD.ReferenceImages/ImagePanel.vue";
import ItemsSection from "../../plugins/FundaCAD.ReferenceImages/ItemsSection.vue";
import { calibrating, selected, tool } from "../../plugins/FundaCAD.ReferenceImages/state";
import { RefImageTool } from "../../plugins/FundaCAD.ReferenceImages/tool";
import { ENGINE } from "../../src/app/engineKey";
import type { Engine } from "../../src/app/engine";
import { reloadLanguageFiles, setLanguage } from "../../src/i18n";
import { usePromptStore } from "../../src/stores/prompt";
import { useToastStore } from "../../src/stores/toasts";
import { stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

const image = (over: Record<string, unknown> = {}) => ({
  id: "ri1",
  name: "Front photo",
  image: "0123456789abcdef0123456789abcdef",
  mime: "image/png",
  px: [400, 300],
  plane: "XY",
  at: [0, 0],
  width: 200,
  angle: 15,
  flipX: false,
  flipY: false,
  opacity: 0.5,
  locked: false,
  hidden: false,
  ...over,
});

function fakeEngine(list: Record<string, unknown>[]) {
  const store = {
    referenceImages: () => list,
    setReferenceImages: vi.fn(),
    onReferenceImagesChange(fn: (l: readonly Record<string, unknown>[]) => void) {
      fn(list);
      return () => {};
    },
  };
  return { engine: { store, bridge: { docVersion: ref(0) } } as unknown as Engine };
}

const fakeTool = () => ({
  write: vi.fn(),
  cancel: vi.fn(),
  endGesture: vi.fn(),
  startCalibrate: vi.fn(),
  finishCalibrate: vi.fn((): string | null => null),
  remove: vi.fn(),
  missing: vi.fn((id: string) => id === "ri2"),
});

async function openPanel(over: Record<string, unknown> = {}) {
  tool.value = fakeTool() as unknown as RefImageTool;
  selected.value = "ri1";
  mount(ImagePanel, {
    attachTo: document.body,
    global: { provide: { [ENGINE as symbol]: fakeEngine([image(over)]).engine } },
  });
  await flushPromises();
  return document.querySelector<HTMLElement>("[data-panel=reference-image]")!.closest(".ui-panel") as HTMLElement;
}

async function openSection() {
  tool.value = fakeTool() as unknown as RefImageTool;
  const list = [image(), image({ id: "ri2", name: "Side drawing", locked: true, hidden: true })];
  mount(ItemsSection, {
    attachTo: document.body,
    global: { provide: { [ENGINE as symbol]: fakeEngine(list).engine } },
  });
  await flushPromises();
}

const tips = () =>
  [...document.querySelectorAll<HTMLElement>("button[aria-label]")].map((b) => b.getAttribute("aria-label"));
const rowLabels = (root: Element) => [...root.querySelectorAll("label")].map((l) => l.textContent?.trim());
const buttons = (root: Element) => [...root.querySelectorAll("button")].map((b) => b.textContent?.trim());

beforeEach(async () => {
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  stubResizeObserver(vi.stubGlobal);
  await setLanguage("en");
});

afterEach(async () => {
  selected.value = null;
  calibrating.value = null;
  tool.value = null;
  vi.unstubAllGlobals();
  await reloadLanguageFiles();
  await setLanguage("system");
});

describe("the reference image panel follows the language", () => {
  it("reads English, then German and Japanese after a switch", async () => {
    const root = await openPanel();
    expect(rowLabels(root)).toEqual(expect.arrayContaining(["Width", "Angle", "Opacity", "Lock"]));
    expect(buttons(root)).toEqual(expect.arrayContaining(["Close", "Calibrate"]));

    await setLanguage("de");
    await nextTick();
    expect(rowLabels(root)).toEqual(expect.arrayContaining(["Breite", "Winkel", "Deckkraft", "Sperren"]));
    expect(buttons(root)).toEqual(expect.arrayContaining(["Schließen", "Kalibrieren"]));
    expect(root.textContent).toContain("Ziehen Sie das Bild mit gedrückter Umschalttaste");
    expect(root.textContent).toContain("X spiegeln");

    await setLanguage("ja");
    await nextTick();
    expect(rowLabels(root)).toEqual(expect.arrayContaining(["幅", "角度", "不透明度", "ロック"]));
    expect(buttons(root)).toEqual(expect.arrayContaining(["閉じる", "キャリブレーション"]));
  });

  it("says the calibration steps and its refusal in the language", async () => {
    await setLanguage("de");
    const root = await openPanel();
    calibrating.value = { id: "ri1", stage: "first" };
    await nextTick();
    expect(root.querySelector("[role=status]")?.textContent).toBe("Klicken Sie auf den ersten Punkt im Bild.");
    expect(buttons(root)).toContain("Abbrechen");

    calibrating.value = { id: "ri1", stage: "distance", a: [0, 0], b: [10, 0] };
    await flushPromises();
    expect(root.querySelector("[role=status]")?.textContent).toBe("Der tatsächliche Abstand zwischen beiden:");
    const field = root.querySelector<HTMLInputElement>("[data-field=distance]")!;
    field.value = "-5";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(root.querySelector("[role=alert]")?.textContent).toContain("Fehler: Abstand: Geben Sie eine Länge");
  });
});

describe("the reference image folder follows the language", () => {
  it("names the folder, its tips and the missing image in the new language", async () => {
    await openSection();
    expect(document.body.textContent).toContain("Reference images");
    expect(tips()).toContain("Delete Front photo");

    await setLanguage("de");
    await nextTick();
    expect(document.body.textContent).toContain("Referenzbilder");
    expect(document.body.textContent).toContain("Bild nicht gefunden");
    expect(tips()).toEqual(
      expect.arrayContaining([
        "Referenzbilder zuklappen",
        "Front photo löschen",
        "Side drawing einblenden",
        "Front photo ausblenden",
      ]),
    );

    await setLanguage("ja");
    await nextTick();
    expect(tips()).toEqual(expect.arrayContaining(["Front photoを削除", "Side drawingを表示"]));
  });
});

describe("the reference image tool speaks the language", () => {
  const plain = (name: string, type: string, size = 10) => {
    const file = new File(["x"], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
  };

  it("refuses a file in the language of the toast", async () => {
    const e = { geometry: {}, store: {} } as unknown as Engine;
    const t = new RefImageTool(e, {} as never);
    const messages = () => useToastStore().items.map((i) => i.message);

    await t.add(plain("notes.txt", "text/plain"), "XY", null);
    expect(messages()).toContain("A reference image has to be a PNG or a JPEG");

    await setLanguage("de");
    await t.add(plain("notes.txt", "text/plain"), "XY", null);
    expect(messages()).toContain("Ein Referenzbild muss eine PNG- oder JPEG-Datei sein");
    await t.add(plain("big.png", "image/png", 40 * 1024 * 1024), "XY", null);
    expect(messages()).toContain(
      "Dieses Bild ist größer als 32 MB, speichern Sie eine kleinere Kopie und fügen Sie diese ein",
    );

    await setLanguage("ja");
    await t.add(plain("a.png", "image/png"), "XY", null);
    expect(messages()).toContain("画像の挿入にはジオメトリエンジンが必要です");
  });

  it("prompts for the calibration points in the language", async () => {
    await setLanguage("de");
    const e = {
      geometry: {},
      toolBusy: () => false,
      viewport: { suspendPicking: false, domElement: document.createElement("canvas") },
      store: { referenceImages: () => [image()] },
    } as unknown as Engine;
    const t = new RefImageTool(e, {} as never);
    t.startCalibrate("ri1");
    expect(usePromptStore().text).toBe("Klicken Sie auf den ersten Punkt im Bild");
    t.cancel();
  });
});
