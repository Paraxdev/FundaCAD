// The viewport context menus, the Interference and Properties panels and the lists that were module constants read
// in the chosen language, follow a live switch, and keep the English names the harness finds rows by.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { setLanguage } from "../../src/i18n";
import { createContextMenus, type ContextMenusDeps } from "../../src/ui/contextMenus";
import { useContextMenuStore } from "../../src/stores/contextMenu";
import { createPanels, type PanelsDeps } from "../../src/ui/panels";
import { usePanelsStore } from "../../src/stores/panels";
import { interferenceSummary } from "../../src/ui/interferenceRows";
import { WORKSPACES } from "../../src/ui/workspace";
import { iconPacks } from "../../src/ui/icons";
import { materialOptions } from "../../src/ui/stress";
import type { InterferenceReply } from "../../src/geometry/client";
import type { CadDocument } from "../../src/types";

vi.mock("../../src/ui/announce", () => ({ announce: () => {} }));

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => setLanguage("system"));

function emptyMenu(): { label: string; refName?: string }[] {
  const deps = {
    sketch: { active: false },
    store: { document: { features: [] } },
    viewport: {},
    toolBusy: () => false,
    getLastAction: () => null,
  } as unknown as ContextMenusDeps;
  createContextMenus(deps).openEmptyMenu(10, 10);
  return useContextMenuStore()
    .items.filter((i) => !i.separator)
    .slice(0, 4);
}

const OPEN = "is not a closed solid, 4 of its edges bound only one face, so it has no inside";

function rig(reply: InterferenceReply) {
  const statuses: string[] = [];
  const bodies = [
    { id: "body1", name: "Deckel" },
    { id: "body2", name: "Gehäuse", fault: OPEN },
  ];
  const deps = {
    store: {
      document: { features: [] } as unknown as CadDocument,
      buildState: { result: { bodies } },
      bodyName: () => undefined,
      onDocChange: () => {},
      onOpen: () => {},
      onBuild: () => () => {},
    },
    viewport: {
      setInterferenceOverlay: () => {},
      setFaceMarks: () => {},
      setSelectedBodies: () => {},
      getSelectedBodies: () => [],
      setComMarker: () => {},
      bodyProperties: () => ({
        volume: 1000,
        area: 600,
        com: new THREE.Vector3(0, 0, 5),
        bbox: new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 10, 10)),
        ids: ["body1", "body2"],
        names: ["Deckel", "Gehäuse"],
      }),
    },
    geometry: { interference: async () => reply },
    hasBody: () => true,
    setStatus: (text: string) => statuses.push(text),
  } as unknown as PanelsDeps;
  return { panels: createPanels(deps), statuses };
}

const clash = {
  a: "body1",
  b: "body2",
  aName: "Deckel",
  bName: "Gehäuse",
  volume: 2.5,
  bbox: { min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] },
};
const reply: InterferenceReply = {
  ok: true,
  pairs: [clash],
  unchecked: [{ id: "body2", name: "Gehäuse", reason: OPEN }],
};

describe("the viewport menus in another language", () => {
  it("read German and Japanese while the harness names stay English", async () => {
    await setLanguage("de");
    const de = emptyMenu();
    expect(de.map((i) => i.label)).toEqual([
      "Letzten Befehl wiederholen",
      "Ansicht einpassen",
      "Blickrichtung",
      "Alle Körper einblenden",
    ]);
    expect(de.map((i) => i.refName)).toEqual(["Repeat last command", "Fit view", "Look", "Show all bodies"]);

    await setLanguage("ja");
    expect(emptyMenu().map((i) => i.label)).toEqual([
      "直前のコマンドを繰り返す",
      "全体表示",
      "視点",
      "すべてのボディを表示",
    ]);
  });
});

describe("the Interference panel in another language", () => {
  it("says the result and names a body it could not check, in German and Japanese", async () => {
    await setLanguage("de");
    const { panels, statuses } = rig(reply);
    await panels.showInterference();
    expect(statuses.at(-1)).toBe("1 Kollision, 1 Körper konnte nicht geprüft werden");
    const p = usePanelsStore().interference!;
    expect(p.clashes.map((c) => c.label)).toEqual(["Deckel und Gehäuse"]);
    expect(p.unchecked).toEqual([
      "Gehäuse ist kein geschlossener Volumenkörper und hat daher kein Inneres: 4 Kanten grenzen nur an eine Fläche",
    ]);
    expect(interferenceSummary(0, 2, 0)).toBe("Kollisionsprüfung: keine Kollisionen, 2 nahe Paare");

    await setLanguage("ja");
    const ja = rig(reply);
    await ja.panels.showInterference();
    expect(ja.statuses.at(-1)).toBe("干渉 1 件、1 個のボディは確認できませんでした");
    expect(usePanelsStore().interference!.unchecked[0]).toBe(
      "Gehäuse は閉じたソリッドではありません。4 本のエッジが 1 つの面にしか接していないため、内側がありません",
    );
  });
});

describe("the Properties panel in another language", () => {
  it("names its rows and the selection in German and Japanese", async () => {
    await setLanguage("de");
    const { panels } = rig(reply);
    panels.showProperties();
    const p = usePanelsStore().properties!;
    expect(p.rows.map((r) => r.k)).toEqual(["Oberfläche", "Begrenzungsquader"]);
    expect(p.faults).toEqual([
      "Gehäuse ist kein geschlossener Volumenkörper und hat daher kein Inneres: 4 Kanten grenzen nur an eine Fläche",
    ]);

    await setLanguage("ja");
    rig(reply).panels.showProperties();
    expect(usePanelsStore().properties!.rows.map((r) => r.k)).toEqual(["表面積", "バウンディングボックス"]);
  });
});

describe("lists that were module constants", () => {
  it("follow a switch on the same objects", async () => {
    const packs = iconPacks();
    expect(WORKSPACES.map((w) => w.label)).toEqual(["Model", "Render"]);
    expect(packs.slice(0, 2).map((p) => p.label)).toEqual(["Forge (outline)", "Anvil (solid)"]);

    await setLanguage("de");
    expect(WORKSPACES.map((w) => w.label)).toEqual(["Modell", "Rendern"]);
    expect(packs.slice(0, 2).map((p) => p.label)).toEqual(["Forge (Kontur)", "Anvil (gefüllt)"]);
    expect(materialOptions().map((m) => m.label)).toContain("Stahl S235");
    expect(materialOptions().map((m) => m.value)).toContain("steel S235");

    await setLanguage("ja");
    expect(WORKSPACES.map((w) => w.label)).toEqual(["モデル", "レンダリング"]);
  });
});
