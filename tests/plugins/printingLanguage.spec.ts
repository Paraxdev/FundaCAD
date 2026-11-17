// The Printing plugin's filament mapping dialog, camera panel, progress pill and its own sentences read in the chosen
// language through the plugin's lines. What a printer sends back stays as it arrives. The printer client is stubbed,
// no device or network is reached.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const printer = vi.hoisted(() => {
  const state = {
    offline: null as null | ((id: string) => void),
  };
  return {
    state,
    start: vi.fn(async () => {}),
    stop: vi.fn(),
  };
});
vi.mock("../../plugins/FundaCAD.Printing/printerClient", () => ({
  printerCameraStart: printer.start,
  printerCameraStop: printer.stop,
  onPrinterCameraFrame: () => () => {},
  onPrinterCameraOffline: (fn: never) => {
    printer.state.offline = fn;
    return () => {};
  },
}));

import CameraPanel from "../../plugins/FundaCAD.Printing/CameraPanel.vue";
import FilamentMappingDialog from "../../plugins/FundaCAD.Printing/FilamentMappingDialog.vue";
import PrintStatusPill from "../../plugins/FundaCAD.Printing/PrintStatusPill.vue";
import { t } from "../../plugins/FundaCAD.Printing/lines";
import { toolheadLabel } from "../../plugins/FundaCAD.Printing/printDialog";
import { usePrintStatusStore } from "../../plugins/FundaCAD.Printing/printStatus";
import { cameraPanel, type FilamentReq } from "../../plugins/FundaCAD.Printing/state";
import { setLanguage } from "../../src/i18n";
import { byName, nameOf, stubResizeObserver } from "./pluginA11y";

enableAutoUnmount(afterEach);

beforeEach(async () => {
  document.body.innerHTML = "";
  setActivePinia(createPinia());
  stubResizeObserver(vi.stubGlobal);
  cameraPanel.value = null;
  await setLanguage("en");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await setLanguage("system");
});

function request(): FilamentReq {
  return {
    slots: [
      { index: 0, name: "Polymaker PLA", color: "#d23b30", material: "PLA" },
      { index: 1, name: "", color: "#2255cc" },
    ],
    toolheads: [
      { index: 0, vendor: "Polymaker", material: "PLA", sub_type: "", color: "#d23b30", present: true },
      { index: 1, vendor: "", material: "", sub_type: "", color: "#2255cc", present: true },
      { index: 2, vendor: "Generic", material: "PETG", sub_type: "", color: "#ffffff", present: false },
    ],
    resolve: vi.fn(),
  };
}

async function mapping() {
  mount(FilamentMappingDialog, { props: { req: request() }, attachTo: document.body });
  await flushPromises();
  return document.body;
}

describe("the filament mapping dialog follows the language", () => {
  it("reads German, with the toolhead picks named after their slots", async () => {
    await setLanguage("de");
    const root = await mapping();
    expect(nameOf(root.querySelector("[role=dialog]")!)).toBe("An Drucker senden, Filamentzuordnung");
    expect(nameOf(root.querySelector("ul")!)).toBe("Filamentplätze");
    expect(nameOf(root.querySelector("[role=group]")!)).toBe("Startoptionen");
    const picks = [...root.querySelectorAll<HTMLElement>("[role=combobox]")].map((el) => nameOf(el));
    expect(picks).toEqual([
      "Werkzeugkopf für Polymaker PLA, 1: Polymaker PLA",
      "Werkzeugkopf für Filament 2, 2: Werkzeugkopf 2",
    ]);
    expect(byName(root, "button", "Abbrechen")).toBeDefined();
    expect(byName(root, "button", "Hochladen und drucken")).toBeDefined();
    expect(byName(root, "input[type=checkbox]", "Zeitraffer")).toBeDefined();
  });

  it("reads Japanese", async () => {
    await setLanguage("ja");
    const root = await mapping();
    expect(nameOf(root.querySelector("[role=dialog]")!)).toBe("プリンターに送信、フィラメントの割り当て");
    expect(byName(root, "input[type=checkbox]", "自動ベッドレベリング")).toBeDefined();
    expect(byName(root, "button", "アップロードして印刷")).toBeDefined();
  });

  it("labels a toolhead in the language it is read in, empty or not", async () => {
    const head = { index: 2, vendor: "", material: "", sub_type: "", color: "#fff", present: false };
    expect(toolheadLabel(head)).toBe("3: Toolhead 3 (empty)");
    await setLanguage("fr");
    expect(toolheadLabel(head)).toBe("3 : Tête d'outil 3 (vide)");
    await setLanguage("zh-CN");
    expect(toolheadLabel({ ...head, vendor: "Generic", material: "PETG", present: true })).toBe("3: Generic PETG");
  });
});

describe("the camera panel and progress pill follow the language", () => {
  it("names the panel and puts an offline camera behind the language's Error word", async () => {
    await setLanguage("fr");
    mount(CameraPanel, { attachTo: document.body });
    cameraPanel.value = "u1";
    await flushPromises();
    expect(document.body.textContent).toContain("Caméra, u1");
    expect(document.body.textContent).toContain("Échap pour fermer");
    expect(document.body.querySelector("img")?.getAttribute("alt")).toBe("Pas encore d'image de la caméra");
    printer.state.offline?.("u1");
    await flushPromises();
    expect(document.body.querySelector("[role=alert]")?.textContent).toBe("Erreur : caméra indisponible");
    expect(byName(document.body, "button", "Réessayer")).toBeDefined();
  });

  it("shows the camera button of the pill in Spanish and keeps the progress text it was given", async () => {
    await setLanguage("es");
    const status = usePrintStatusStore();
    status.text = "En pausa part.gcode, 40 %";
    status.onClick = vi.fn();
    mount(PrintStatusPill, { attachTo: document.body });
    await flushPromises();
    const pill = document.body.querySelector("[role=status]")!;
    expect(pill.textContent).toContain("En pausa part.gcode, 40 %");
    expect(byName(pill, "button", "Mostrar cámara")).toBeDefined();
  });
});

describe("the Printing sentences follow the language", () => {
  it("says the progress with the language's percent", async () => {
    expect(t("status.printing", { file: "part.gcode", percent: 40 })).toBe("Printing part.gcode, 40%");
    await setLanguage("de");
    expect(t("status.printing", { file: "part.gcode", percent: 40 })).toBe("Druckt part.gcode, 40 %");
    await setLanguage("ja");
    expect(t("status.paused", { file: "part.gcode", percent: 40 })).toBe("一時停止中 part.gcode、40%");
  });

  it("picks the plural for slots and bodies", async () => {
    const one = { n: 1, list: "2" };
    const two = { n: 2, list: "1, 3" };
    expect(t("export.warnSlots", one)).toBe("slot 2 has no filament loaded on the printer");
    expect(t("export.warnSlots", two)).toBe("slots 1, 3 have no filament loaded on the printer");
    expect(t("export.warnBodies", { n: 1 })).toBe("1 body is unassigned (defaulting to slot 1)");
    await setLanguage("de");
    expect(t("export.warnSlots", one)).toBe("Platz 2 hat kein Filament im Drucker geladen");
    expect(t("export.warnSlots", two)).toBe("Plätze 1, 3 haben kein Filament im Drucker geladen");
    expect(t("sync.overwriteHint", { n: 3 })).toBe("3 Plätze");
    await setLanguage("ja");
    expect(t("sync.overwriteHint", { n: 3 })).toBe("3 スロット");
  });

  it("keeps what the printer said as it came inside the plugin's own sentence", async () => {
    await setLanguage("de");
    expect(t("toast.nozzle", { message: "Nozzle diameter differs" })).toBe("Düsenkonflikt, Nozzle diameter differs");
    expect(t("error.unreachable", { message: "connection refused" })).toBe(
      "Der Drucker ist nicht erreichbar: connection refused",
    );
  });
});
