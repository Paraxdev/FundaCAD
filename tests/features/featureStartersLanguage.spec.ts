// The feature starters' prompts, refusals and pick lists, the selection target rows and the tool labels read in the
// chosen language, and a row label read after a switch follows it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { describeTarget, targetsOf, type TargetField } from "../../src/features/selectionTargets";
import { capabilityOf } from "../../src/features/toolCapabilities";
import { setLanguage, t } from "../../src/i18n";
import { usePromptStore } from "../../src/stores/prompt";
import { resetTreePicks, routeTreeClick, type TreePick } from "../../src/ui/treePick";
import type { Selector } from "../../src/types";

type Asked = { title: string; options: { label: string; hint?: string }[] };
const choices = vi.hoisted(() => ({ asked: [] as Asked[] }));
vi.mock("../../src/ui/choice", () => ({
  choose: async (title: string, options: Asked["options"]) => {
    choices.asked.push({ title, options });
    return null;
  },
}));

let frames: (() => void)[] = [];
const flushFrame = () => {
  const run = frames;
  frames = [];
  for (const f of run) f();
};
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

function rig(bodies: { id: string; name: string }[] = []) {
  const canvas = document.createElement("canvas");
  let planePick = false;
  const deps = {
    store: {
      document: { parameters: {}, features: [] },
      buildState: { result: { bodies, mesh: { positions: bodies.length ? [0] : [] } } },
      nextId: () => "f9",
      addFeature: vi.fn(),
    },
    viewport: {
      domElement: canvas,
      suspendPicking: false,
      showAllPlanes: vi.fn(),
      clearHover: () => {},
      hoverDatum: () => {},
      hoverBody: () => {},
      setPickMarkers: vi.fn(),
      selectedFaceSketchPlane: () => null,
      getSelectedBodies: () => [],
      setSelectedBodies: vi.fn(),
    },
    overlay: { regions: [], selectedRegions: () => [] },
    sketch: { enter: vi.fn() },
    datumPose: { start: vi.fn() },
    canvas,
    toolBusy: () => planePick,
    hasBody: () => bodies.length > 0,
    setStatus: vi.fn(),
    selectFeature: vi.fn(),
    noteCommitted: vi.fn(),
    isSketchConsumed: () => false,
    getSelectedFeature: () => null,
    setPlanePick: (v: boolean) => {
      planePick = v;
    },
    datumMoveTarget: () => null,
  } as unknown as FeatureStartersDeps;
  const hints: string[] = [];
  const click = (pick: TreePick) => routeTreeClick(pick, { busyHint: () => null, hint: (h) => hints.push(h) });
  const status = () => (deps.setStatus as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string);
  return { starters: createFeatureStarters(deps), hints, click, status };
}

const two = [
  { id: "b1", name: "A" },
  { id: "b2", name: "B" },
];
const prompt = () => usePromptStore().text;
const field = (type: string, name: string): TargetField => targetsOf(type).find((f) => f.field === name)!;
const edges = (n: number): Selector[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "edge", by: "nearest", point: [i, 0, 0] }));

beforeEach(() => {
  setActivePinia(createPinia());
  choices.asked = [];
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: () => void) => {
    frames.push(f);
    return frames.length;
  });
});
afterEach(async () => {
  resetTreePicks();
  vi.unstubAllGlobals();
  await setLanguage("system");
});

describe("feature starters in German", () => {
  beforeEach(() => setLanguage("de"));

  it("asks for the reference plane and counts the points taken", () => {
    rig().starters.offsetPlane();
    expect(prompt()).toBe("Wählen Sie eine Ebene oder Fläche als Ausgang für den Versatz");
    resetTreePicks();
    rig().starters.createPlaneThroughPoints();
    expect(prompt()).toBe("Wählen Sie drei Punkte für die Ebene · 0 von 3 · Esc");
  });

  it("refuses a tool that has no body to work on", async () => {
    const r = rig();
    await r.starters.startSplit();
    r.starters.startBoolean("union");
    r.starters.startMove();
    expect(r.status()).toEqual([
      "Teilen: Erstellen oder importieren Sie zuerst einen Körper",
      "Vereinigen benötigt zwei Körper",
      "Verschieben: Wählen Sie zuerst einen Körper oder eine Skizze aus",
    ]);
  });

  it("offers the sides Split Body can keep", async () => {
    await rig([{ id: "b1", name: "A" }]).starters.startSplit();
    expect(choices.asked[0]).toEqual({
      title: "Körper teilen, welche Seite behalten?",
      options: [
        { value: "both", label: "Beide", hint: "zwei Körper" },
        { value: "top", label: "Oben", hint: "Seite +Normale" },
        { value: "bottom", label: "Unten", hint: "Seite −Normale" },
      ],
    });
  });

  it("walks a boolean and refuses the body it already has", () => {
    const r = rig(two);
    r.starters.startBoolean("intersect");
    expect(prompt()).toBe("Klicken Sie auf den ersten Körper, der geschnitten werden soll · Esc bricht ab");
    expect(r.click({ kind: "body", id: "b1" })).toBe("taken");
    flushFrame();
    expect(prompt()).toBe("Klicken Sie auf den Körper, mit dem geschnitten werden soll · Esc bricht ab");
    expect(r.click({ kind: "body", id: "b1" })).toBe("refused");
    expect(r.hints).toEqual(["Dieser Körper ist bereits Teil dieser Operation, wählen Sie einen anderen"]);
  });

  it("counts the picks of a selection target row with one and with three", () => {
    expect(describeTarget(field("fillet", "edges"), edges(1))).toBe("1 Kante");
    expect(describeTarget(field("fillet", "edges"), edges(3))).toBe("3 Kanten");
    expect(describeTarget(field("fillet", "edges"), [])).toBe("nichts ausgewählt");
    expect(describeTarget(field("shell", "faces"), [])).toBe("geschlossener Hohlkörper");
    expect(t("tool.mechanism.soFar", { n: 1 })).toBe(
      "Mechanismus: bisher 1 Gelenk, fügen Sie ein weiteres hinzu oder schließen Sie ab",
    );
    expect(t("tool.mechanism.soFar", { n: 3 })).toBe(
      "Mechanismus: bisher 3 Gelenke, fügen Sie ein weiteres hinzu oder schließen Sie ab",
    );
  });
});

describe("feature starters in Japanese", () => {
  beforeEach(() => setLanguage("ja"));

  it("lists the primitives with their own hints", async () => {
    await rig().starters.startPrimitive();
    const [asked] = choices.asked;
    expect(asked?.title).toBe("プリミティブを作成");
    expect(asked?.options.map((o) => o.label)).toEqual([
      "ボックス",
      "円柱",
      t("feature.cone"),
      t("feature.sphere"),
      t("feature.torus"),
    ]);
    expect(asked?.options.map((o) => o.hint)).toEqual([
      "長さ×幅×高さ",
      "半径、高さ",
      "半径1、半径2、高さ",
      "半径",
      "リング、チューブ",
    ]);
  });

  it("walks a mechanism from the ground body to the first joint kind, and says when it is cancelled", async () => {
    const r = rig(two);
    const done = r.starters.startMechanism();
    expect(prompt()).toBe("メカニズム: 動かない「固定側」のボディを選択 · Esc でキャンセル");
    expect(r.click({ kind: "body", id: "b1" })).toBe("taken");
    flushFrame();
    await settle();
    await done;
    expect(choices.asked[0]).toEqual({
      title: "メカニズム: 1つ目のジョイントの種類は？",
      options: [
        { value: "revolute", label: "回転（ピン）" },
        { value: "slider", label: "スライド" },
        { value: "rigid", label: "剛性" },
      ],
    });
    expect(r.status()).toEqual(["メカニズムをキャンセルしました"]);
  });

  it("refuses a boolean with one body and counts selection target picks", () => {
    const r = rig([{ id: "b1", name: "A" }]);
    r.starters.startBoolean("subtract");
    expect(r.status()).toEqual(["差分には2つのボディが必要です"]);
    expect(describeTarget(field("fillet", "edges"), edges(1))).toBe("1 本のエッジ");
    expect(describeTarget(field("fillet", "edges"), edges(3))).toBe("3 本のエッジ");
    expect(t("tool.mechanism.soFar", { n: 3 })).toBe(
      "メカニズム: これまでにジョイント 3 個。追加するか完了してください",
    );
  });
});

describe("labels read after a switch", () => {
  it("a selection target row and a tool label speak the new language", async () => {
    const profile = targetsOf("extrude")[0]!;
    const kept = field("boolean", "target");
    const fillet = capabilityOf("fillet")!;
    expect([profile.label, kept.label, fillet.label]).toEqual(["Profile", "Body kept", "Fillet"]);
    await setLanguage("de");
    expect([profile.label, kept.label, fillet.label]).toEqual(["Profil", "Behaltener Körper", t("tool.fillet")]);
    expect(fillet.label).not.toBe("Fillet");
    await setLanguage("ja");
    expect([profile.label, kept.label]).toEqual(["プロファイル", "残すボディ"]);
    expect(field("move", "bodies").whenEmpty).toBe("アクティブなボディ");
  });
});
