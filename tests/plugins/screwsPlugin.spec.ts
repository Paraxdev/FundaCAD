// The fastener plugin's real activate() against a faked engine: what it adds, how an insert becomes an
// import feature carrying its spec, where it is placed, and that switching it off takes it all away.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createPinia, setActivePinia } from "pinia";
import { activate } from "../../plugins/FundaCAD.Screws/main";
import { insertFastener, placementFromSelection, specOfBody } from "../../plugins/FundaCAD.Screws/insert";
import { expand } from "../../plugins/FundaCAD.Screws/catalogue";
import { dragging, open } from "../../plugins/FundaCAD.Screws/state";
import {
  contributedAction, contributedBodyMenu, contributedOverlays, contributedRibbon, contributors, resetContributions,
} from "../../src/plugins/contrib";
import type { Engine } from "../../src/app/engine";

function fakeEngine() {
  const canvas = document.createElement("canvas");
  const state = {
    added: [] as Record<string, unknown>[],
    faces: [] as number[],
    planar: true,
    calls: [] as unknown[][],
    reply: { ok: true, shape: { solid: true, valid: true, faces: 20, volume: 132, bbox: { min: [0, 0, 0], max: [1, 1, 1] }, geom: "a".repeat(32) } } as unknown,
  };
  const viewport = {
    domElement: canvas,
    selectedFacesForPressPull: () => state.faces.length
      ? { faceIds: state.faces, anchor: new THREE.Vector3(1, 2, 3), normal: new THREE.Vector3(0, 1, 0), selectors: [], bodyId: "b1", round: null }
      : null,
    planarFace: () => (state.planar ? { normal: new THREE.Vector3(0, 1, 0), origin: new THREE.Vector3(1, 2, 3) } : null),
    hoverFaceAt: () => 7,
    pointAt: () => ({ p: new THREE.Vector3(4, 5, 6), kind: "surface" }),
  };
  const store = {
    nextId: () => `f${state.added.length + 1}`,
    addFeature: (f: Record<string, unknown>) => { state.added.push(f); },
    document: { features: state.added },
    buildState: { result: { bodies: [{ id: "b1", faceOwners: ["f1", "f1"] }] } },
  };
  const e = {
    viewport,
    store,
    geometry: {
      generateShape: vi.fn(async (...args: unknown[]) => { state.calls.push(args); return state.reply; }),
    },
    setStatus: vi.fn(),
    noteCommitted: vi.fn(),
    selectFeature: vi.fn(),
  };
  return { e: e as unknown as Engine, state, canvas };
}

describe("the fastener library, switched on and off", () => {
  let stop: () => void;
  let engine: ReturnType<typeof fakeEngine>;

  beforeEach(async () => {
    setActivePinia(createPinia());
    resetContributions();
    engine = fakeEngine();
    stop = await activate(engine.e);
  });

  afterEach(() => {
    stop();
    resetContributions();
  });

  it("adds a Fasteners button to INSERT that opens the library panel", () => {
    expect(contributors()).toEqual(["FundaCAD.Screws"]);
    const group = contributedRibbon().find((g) => g.group === "INSERT");
    expect(group?.items.map((i) => i.action)).toEqual(["fasteners"]);
    expect(contributedOverlays()).toHaveLength(1);
    expect(open.value).toBe(false);
    contributedAction("fasteners")!();
    expect(open.value).toBe(true);
  });

  it("inserts a fastener as an import feature holding its blob and its spec", async () => {
    const spec = expand({ familyId: "iso4762", size: "M3", length: 10 });
    const id = await insertFastener(engine.e, spec, null);
    expect(id).toBe("f1");
    expect(engine.state.calls[0]).toEqual(["fastener", spec, { output: "store" }]);
    expect(engine.state.added).toEqual([{
      id: "f1", type: "import", format: "brep", name: "ISO 4762 M3x10", geom: "a".repeat(32), solid: true,
      generatedBy: { plugin: "FundaCAD.Screws", spec },
    }]);
    expect(specOfBody(engine.e, "b1")).toEqual(spec);
    const menu = contributedBodyMenu("b1");
    expect(menu.map((m) => m.label)).toEqual(["Fastener Specs..."]);
  });

  it("puts it on a selected flat face, along the face normal", async () => {
    engine.state.faces = [3];
    expect(placementFromSelection(engine.e)).toEqual({ origin: [1, 2, 3], zAxis: [0, 1, 0] });
    engine.state.planar = false;
    expect(placementFromSelection(engine.e)).toBeNull();
    engine.state.planar = true;
    engine.state.faces = [3, 4];
    expect(placementFromSelection(engine.e)).toBeNull();
  });

  it("adds nothing when the engine refuses, and says why", async () => {
    engine.state.reply = { ok: false, message: "Fastener: missing head diameter" };
    const spec = expand({ familyId: "iso4762", size: "M3", length: 10 });
    expect(await insertFastener(engine.e, spec, null)).toBeNull();
    expect(engine.state.added).toEqual([]);
    expect(engine.e.setStatus).toHaveBeenLastCalledWith("Could not insert ISO 4762 M3x10", "");
  });

  it("inserts a row dropped on a face where it landed", async () => {
    const spec = expand({ familyId: "iso4032", size: "M5" });
    dragging.value = spec;
    const drop = new Event("drop", { cancelable: true }) as DragEvent;
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["application/x-fundacad-fastener"] } });
    Object.assign(drop, { clientX: 10, clientY: 20 });
    engine.canvas.dispatchEvent(drop);
    await vi.waitFor(() => expect(engine.state.added).toHaveLength(1));
    expect(engine.state.calls[0]).toEqual(["fastener", spec, { output: "store", placement: { origin: [4, 5, 6], zAxis: [0, 1, 0] } }]);
    expect(drop.defaultPrevented).toBe(true);
  });

  it("takes everything away when switched off", () => {
    open.value = true;
    stop();
    expect(contributors()).toEqual([]);
    expect(contributedRibbon()).toEqual([]);
    expect(open.value).toBe(false);
    const spec = expand({ familyId: "iso4032", size: "M5" });
    dragging.value = spec;
    const drop = new Event("drop", { cancelable: true });
    Object.defineProperty(drop, "dataTransfer", { value: { types: ["application/x-fundacad-fastener"] } });
    engine.canvas.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    dragging.value = null;
  });
});
