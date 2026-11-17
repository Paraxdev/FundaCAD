// Pin 2: a feature edited through the properties panel in German saves the same bytes as the same edit in English, and a
// second document opened after the first reads in the language with nothing of the first left in its rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import FeatureProperties from "../../src/components/shell/FeatureProperties.vue";
import { createDocBridge } from "../../src/app/docBridge";
import { ENGINE } from "../../src/app/engineKey";
import type { Engine } from "../../src/app/engine";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";
import { setLanguage } from "../../src/i18n";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";

const backend = {
  async rebuild(): Promise<RebuildReply> {
    return {
      ok: true,
      result: { mesh: { positions: [], indices: [], faceIds: [] }, edges: [], bbox: null, bodies: [] },
    } as unknown as RebuildReply;
  },
  async init() {},
  onStatus() {
    return () => {};
  },
  connected: true,
} as unknown as GeometryBackend;

const FIRST = (): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "s1",
      type: "sketch",
      plane: "XY",
      entities: [{ type: "circle", id: "c1", x: 11.25, y: -3.5, radius: 6.5 }],
    },
    { id: "dp1", type: "datumPlane", plane: "XY", name: "Platte", offset: 23.5, shiftX: 23.5, tiltX: 17 },
    { id: "e1", type: "extrude", sketch: "s1", distance: 5, operation: "new" },
    {
      id: "h1",
      type: "hole",
      points: [[4.5, -2.25, 10]],
      face: { kind: "face", by: "nearest", point: [4.5, -2.25, 10] },
      holeType: "simple",
      standard: "clearance",
      size: "M3",
      diameter: 3.4,
    },
  ] as unknown as Feature[],
});

const SECOND = (): CadDocument => ({
  parameters: {},
  features: [
    {
      id: "s7",
      type: "sketch",
      plane: "XZ",
      entities: [{ type: "circle", id: "c7", x: -8.75, y: 2.125, radius: 3.25 }],
    },
    { id: "dp9", type: "datumPlane", plane: "XZ", name: "Zweite", offset: -4.5, tiltY: 8.5 },
    {
      id: "e7",
      type: "extrude",
      sketch: "s7",
      distance: 9.5,
      operation: "join",
      startType: "plane",
      startPlane: "dp9",
    },
  ] as unknown as Feature[],
});

let open: { store: DocumentStore; w: VueWrapper | null; dispose: () => void } | null = null;

function panel(store: DocumentStore, bridge: ReturnType<typeof createDocBridge>, featureId: string): VueWrapper {
  const engine = {
    store,
    bridge,
    tools: { targetEdit: { active: false, editingId: null, field: null, start: () => true } },
    toolBusy: () => false,
  } as unknown as Engine;
  return mount(FeatureProperties, {
    props: { featureId, unit: "mm" },
    global: { provide: { [ENGINE as symbol]: engine } },
  });
}

const row = (w: VueWrapper, field: string) => w.find(`.param-row[data-field="${field}"]`);

async function choose(w: VueWrapper, field: string, value: string) {
  row(w, field).findComponent({ name: "Select" }).vm.$emit("update:modelValue", value);
  await vi.advanceTimersByTimeAsync(400);
}

async function flip(w: VueWrapper, field: string) {
  await row(w, field).find("[role=switch]").trigger("click");
}

async function type(w: VueWrapper, field: string, text: string) {
  const input = row(w, field).find<HTMLInputElement>("input");
  input.element.value = text;
  await input.trigger("input");
  await input.trigger("keydown", { key: "Enter" });
  await vi.advanceTimersByTimeAsync(400);
}

const shown = (w: VueWrapper, field: string) => row(w, field).find(".select-value").text();

// German reads a point before three digits as a thousands mark, so it is typed with its own comma.
async function session(code: string) {
  await setLanguage(code);
  const mark = (text: string) => (code === "de" ? text.replace(".", ",") : text);
  const store = new DocumentStore(backend, FIRST());
  const bridge = createDocBridge(store);
  open = { store, w: null, dispose: () => bridge.dispose() };

  let w = panel(store, bridge, "e1");
  open.w = w;
  await choose(w, "operation", "cut");
  await choose(w, "startType", "plane");
  await choose(w, "startPlane", "dp1");
  await flip(w, "thin");
  await type(w, "distance", mark("12.375"));
  await type(w, "taper", mark("-3.5"));
  const extrudeRows = ["operation", "startType", "startPlane"].map((f) => shown(w, f));
  w.unmount();

  w = panel(store, bridge, "h1");
  open.w = w;
  await choose(w, "holeType", "counterbore");
  await choose(w, "fit", "loose");
  const fit = shown(w, "fit");
  await choose(w, "standard", "tap");
  await flip(w, "tapped");
  await type(w, "diameter", mark("3.4"));
  const holeRows = [...["holeType", "standard"].map((f) => shown(w, f)), fit];
  w.unmount();

  const saved = store.toJSON();

  store.loadDocument(SECOND());
  await vi.advanceTimersByTimeAsync(400);
  w = panel(store, bridge, "e7");
  open.w = w;
  const planeOptions = row(w, "startPlane").findComponent({ name: "Select" }).props("options") as {
    value: string;
    label: string;
  }[];
  const second = {
    rows: ["operation", "startType", "startPlane"].map((f) => shown(w, f)),
    planeOptions: planeOptions.map((o) => [o.value, o.label]),
    text: w.text(),
    saved: store.toJSON(),
  };
  w.unmount();
  open.w = null;
  return { saved, extrudeRows, holeRows, second };
}

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});

afterEach(async () => {
  open?.w?.unmount();
  open?.dispose();
  open = null;
  vi.useRealTimers();
  await setLanguage("system");
});

describe("choices set through the properties panel", () => {
  it("save the same bytes in German as in English, and the panel read the language", async () => {
    const en = await session("en");
    const de = await session("de");
    expect(de.saved).toBe(en.saved);

    const doc = JSON.parse(en.saved) as { features: Record<string, unknown>[] };
    const e1 = doc.features.find((f) => f.id === "e1")!;
    expect(e1).toMatchObject({
      operation: "cut",
      startType: "plane",
      startPlane: "dp1",
      thin: true,
      distance: 12.375,
      taper: -3.5,
    });
    const h1 = doc.features.find((f) => f.id === "h1")!;
    expect(h1).toMatchObject({ holeType: "counterbore", standard: "tap", fit: "loose", tapped: true });

    expect(en.extrudeRows).toEqual(["Cut", "Plane", "Platte"]);
    expect(de.extrudeRows).toEqual(["Ausschneiden", "Ebene", "Platte"]);
    expect(en.holeRows).toEqual(["Counterbore", "Tap drill", "Loose"]);
    expect(de.holeRows).toEqual(["Flachsenkung", "Kernloch", "Locker"]);
  });

  it("leave a second document reading in the language with nothing of the first in it", async () => {
    const en = await session("en");
    const de = await session("de");
    expect(en.second.saved).toBe(de.second.saved);
    const features = (JSON.parse(de.second.saved) as { features: { id: string }[] }).features;
    expect(features.map((f) => f.id)).toEqual(["s7", "dp9", "e7"]);
    expect(features[2]).toMatchObject(SECOND().features[2]!);
    expect(en.second.rows).toEqual(["Join", "Plane", "Zweite"]);
    expect(de.second.rows).toEqual(["Verbinden", "Ebene", "Zweite"]);
    expect(de.second.planeOptions).toEqual([
      ["XY", "XY"],
      ["XZ", "XZ"],
      ["YZ", "YZ"],
      ["dp9", "Zweite"],
    ]);
    for (const s of [en.second, de.second]) {
      expect(s.text).not.toContain("Platte");
      expect(s.saved).not.toContain("dp1");
      expect(s.saved).not.toContain("counterbore");
    }
  });
});
