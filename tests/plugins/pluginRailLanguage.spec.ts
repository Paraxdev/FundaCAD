import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activate as activateOrganic } from "../../plugins/FundaCAD.Organic/main";
import { activate as activatePrintLook } from "../../plugins/FundaCAD.PrintLook/main";
import { activate as activatePrintToolbox } from "../../plugins/FundaCAD.PrintToolbox/main";
import { activate as activatePrinting } from "../../plugins/FundaCAD.Printing/main";
import { activate as activateRefImages } from "../../plugins/FundaCAD.ReferenceImages/main";
import { activate as activateScrews } from "../../plugins/FundaCAD.Screws/main";
import { activate as activateTexture } from "../../plugins/FundaCAD.Texture/main";
import { reloadLanguageFiles, setLanguage } from "../../src/i18n";
import { resetContributions } from "../../src/plugins/contrib";
import { shippedPluginName } from "../../src/plugins/pluginNames";
import type { Engine } from "../../src/app/engine";
import { allCommands, commandEnglish, groupText } from "../../src/ui/commands";
import { modelRail } from "../../src/ui/railDefs";
import { selectionOffers } from "../../src/ui/selectionTools";

// Any member the plugins call that the test does not give answers with a no-op that returns an unsubscribe.
const stub = (own: object) =>
  new Proxy(own, { get: (t, k) => (k in t ? (t as never)[k] : typeof k === "string" ? () => () => {} : undefined) });
const engine = {
  viewport: stub({ domElement: document.createElement("canvas") }),
  store: stub({ buildState: { result: null } }),
  geometry: {},
} as unknown as Engine;
let stops: (() => void)[] = [];

async function startAll() {
  stops = [
    await activatePrinting(engine),
    await activatePrintLook(engine),
    await activatePrintToolbox(engine),
    await activateOrganic(engine),
    await activateRefImages(engine),
    await activateScrews(engine),
    await activateTexture(engine),
  ];
}

const PLUGIN_ACTIONS = [
  "print-export",
  "print-orca",
  "print-send",
  "layer-lines",
  "print-teardrop",
  "print-roof-bridge",
  "print-counterbore-bridge",
  "print-sacrificial-layer",
  "print-thread-ribs",
  "print-zip-tie-channel",
  "print-elephant-foot-chamfer",
  "print-vertical-fillet",
  "print-bed-fit-check",
  "print-printability",
  "nodeBody",
  "referenceImage",
  "fasteners",
  "standardThread",
  "texture",
];

function railPlugin() {
  const out: { action: string; label: string; english: string | undefined }[] = [];
  let heading: { label: string; english: string } | undefined;
  for (const e of modelRail()) {
    if (e.kind !== "family") continue;
    if (e.id === "cat:PRINT") heading = { label: e.label, english: e.english! };
    for (const i of e.items) {
      if (PLUGIN_ACTIONS.includes(i.action) && !out.some((o) => o.action === i.action))
        out.push({ action: i.action, label: i.label, english: i.english });
    }
  }
  out.sort((a, b) => PLUGIN_ACTIONS.indexOf(a.action) - PLUGIN_ACTIONS.indexOf(b.action));
  return { heading, items: out };
}

const palette = (id: string) => {
  const c = allCommands().find((x) => x.id === id)!;
  return { label: c.label, group: groupText(c.group), english: commandEnglish(id) };
};

beforeEach(async () => {
  setActivePinia(createPinia());
  localStorage.clear();
  await setLanguage("en");
});

afterEach(async () => {
  for (const stop of stops) stop();
  stops = [];
  resetContributions();
  localStorage.clear();
  await reloadLanguageFiles();
  await setLanguage("system");
});

const ENGLISH = [
  ["print-export", "Print Project"],
  ["print-orca", "Open in OrcaSlicer"],
  ["print-send", "Send to Printer"],
  ["layer-lines", "Layer lines"],
  ["print-teardrop", "Teardrop"],
  ["print-roof-bridge", "Roof Bridge"],
  ["print-counterbore-bridge", "Counterbore Bridge"],
  ["print-sacrificial-layer", "Sacrificial Layer"],
  ["print-thread-ribs", "Thread-Forming Ribs"],
  ["print-zip-tie-channel", "Zip-Tie Channel"],
  ["print-elephant-foot-chamfer", "Elephant-Foot Chamfer"],
  ["print-vertical-fillet", "Vertical Edge Fillet"],
  ["print-bed-fit-check", "Bed Fit Check"],
  ["print-printability", "Printability"],
  ["nodeBody", "Node Body"],
  ["referenceImage", "Reference Image"],
  ["fasteners", "Fasteners"],
  ["standardThread", "Standard Thread"],
  ["texture", "Texture"],
] as const;

const GERMAN = [
  "Projekt drucken",
  "In OrcaSlicer öffnen",
  "An den Drucker senden",
  "Schichtlinien",
  "Tropfenform",
  "Dachbrücke",
  "Senkungsbrücke",
  "Opferschicht",
  "Gewindeformende Rippen",
  "Kabelbinder-Kanal",
  "Elefantenfuß-Fase",
  "Verrundung senkrechter Kanten",
  "Bauplatten-Prüfung",
  "Druckbarkeit",
  "Knotenkörper",
  "Referenzbild",
  "Verbindungselemente",
  "Standardgewinde",
  "Textur",
];

describe("plugin rail tools and palette follow the language", () => {
  it("reads English as today, every tool with its own name as the English name", async () => {
    await startAll();
    const r = railPlugin();
    expect(r.heading).toEqual({ label: "Print", english: "Print" });
    expect(r.items.map((i) => [i.action, i.label])).toEqual(ENGLISH.map(([a, l]) => [a, l]));
    expect(r.items.map((i) => i.english)).toEqual(ENGLISH.map(([, l]) => l));
    expect(palette("print-send")).toEqual({ label: "Send to Printer", group: "Print", english: "Send to Printer" });
  });

  it("reads German in the rail with the English names, and finds a tool by its English name", async () => {
    await startAll();
    await setLanguage("de");
    const r = railPlugin();
    expect(r.heading).toEqual({ label: "Drucken", english: "Print" });
    expect(r.items).toEqual(ENGLISH.map(([action, english], n) => ({ action, label: GERMAN[n], english })));
    expect(palette("print-send")).toEqual({
      label: "An den Drucker senden",
      group: "Drucken",
      english: "Send to Printer",
    });
    const q = "send to printer";
    const hits = allCommands().filter((c) => (commandEnglish(c.id) ?? c.label).toLowerCase().includes(q));
    expect(hits.map((c) => [c.id, c.label])).toEqual([["print-send", "An den Drucker senden"]]);
  });

  it("shows the selection rail's plugin tool and plugin name in German", async () => {
    await startAll();
    await setLanguage("de");
    const offer = selectionOffers({ face: 3 }).find((o) => o.tool === "texture")!;
    expect({ label: offer.label, pluginId: offer.pluginId, enabled: offer.enabled }).toEqual({
      label: "Textur",
      pluginId: "FundaCAD.Texture",
      enabled: true,
    });
    expect(shippedPluginName("FundaCAD.Texture")).toBe("Oberflächentextur");
  });

  it("follows a switch to Japanese without starting the plugins again", async () => {
    await startAll();
    await setLanguage("de");
    expect(palette("texture").label).toBe("Textur");
    await setLanguage("ja");
    const r = railPlugin();
    expect(r.heading).toEqual({ label: "印刷", english: "Print" });
    expect(r.items.find((i) => i.action === "print-send")).toEqual({
      action: "print-send",
      label: "プリンターに送信",
      english: "Send to Printer",
    });
    expect(palette("texture")).toEqual({ label: "テクスチャ", group: groupText("MODIFY"), english: "Texture" });
    await setLanguage("en");
    expect(railPlugin().items.map((i) => i.label)).toEqual(ENGLISH.map(([, l]) => l));
  });
});
