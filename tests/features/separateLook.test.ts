// A separated piece looks like the body it came from: palette slot, material,
// folder, visibility and a rename live in the app, so the starter carries them
// over once the build that made the pieces lands.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { createFeatureStarters, type FeatureStartersDeps } from "../../src/features/featureStarters";
import { DocumentStore } from "../../src/document/store";
import type { GeometryBackend } from "../../src/geometry/client";

vi.stubGlobal("window", globalThis);

beforeEach(() => setActivePinia(createPinia()));

function rig() {
  const be = { async init() {}, onStatus: () => () => {}, onProgress: () => () => {}, async cancel() { return true; } } as unknown as GeometryBackend;
  const real = new DocumentStore(be, { parameters: {}, features: [] });
  real.setBodyColorSlot("body1", 3);
  real.setBodiesMaterial(["body1"], "m-steel");
  real.setBodyName("body1", "Bracket");
  real.setBodyVisibility("body1", false);
  let listener: ((s: unknown) => void) | null = null;
  const bodies = [{ id: "body1", name: "Body1" }];
  const store = {
    buildState: { result: { bodies } },
    nextId: () => "f9",
    addFeature: vi.fn(),
    onBuild: (fn: (s: unknown) => void) => { listener = fn; return () => { listener = null; }; },
    bodyName: (id: string) => real.bodyName(id),
    inheritBodyLook: (from: string, pieces: Parameters<DocumentStore["inheritBodyLook"]>[1]) => real.inheritBodyLook(from, pieces),
  };
  const deps = {
    store,
    viewport: { getSelectedBodies: () => ["body1"] },
    toolBusy: () => false,
    setStatus: vi.fn(),
  } as unknown as FeatureStartersDeps;
  return { real, store, starters: createFeatureStarters(deps), fire: (s: unknown) => listener?.(s), bodies };
}

describe("Separate keeps the look", () => {
  it("copies colour, material, visibility and the shown name to each new piece", async () => {
    const r = rig();
    await r.starters.startSeparate();
    expect(r.store.addFeature).toHaveBeenCalledTimes(1);
    r.fire({ building: true, errorFeatureId: null, result: { bodies: r.bodies } });
    r.fire({
      building: false,
      errorFeatureId: null,
      result: { bodies: [...r.bodies, { id: "body2", name: "Body1 2" }, { id: "body3", name: "Body1 3" }] },
    });
    for (const [id, name] of [["body2", "Bracket 2"], ["body3", "Bracket 3"]] as const) {
      expect(r.real.bodyColorSlot(id)).toBe(3);
      expect(r.real.bodyMaterialId(id)).toBe("m-steel");
      expect(r.real.bodyName(id)).toBe(name);
      expect(r.real.isBodyVisible(id)).toBe(false);
    }
  });

  it("is one undo step: undoing it takes the look off the pieces again", async () => {
    const r = rig();
    await r.starters.startSeparate();
    r.fire({ building: true, errorFeatureId: null, result: { bodies: r.bodies } });
    r.fire({
      building: false,
      errorFeatureId: null,
      result: { bodies: [...r.bodies, { id: "body2", name: "Body1 2" }] },
    });
    expect(r.real.bodyColorSlot("body2")).toBe(3);
    r.real.undo();
    expect(r.real.bodyColorSlot("body2")).toBeUndefined();
    expect(r.real.bodyMaterialId("body2")).toBeUndefined();
    expect(r.real.bodyName("body2")).toBeUndefined();
    expect(r.real.bodyColorSlot("body1")).toBe(3);
    r.real.redo();
    expect(r.real.bodyColorSlot("body2")).toBe(3);
  });

  it("moves per face materials to the piece their faces went to", async () => {
    const r = rig();
    r.real.setFacesMaterial([{ body: "body1", face: 2 }, { body: "body1", face: 7 }], "m-steel");
    await r.starters.startSeparate();
    r.fire({
      building: false,
      errorFeatureId: null,
      result: {
        bodies: [...r.bodies, { id: "body2", name: "Body1 2" }],
        diagnostics: [{
          feature_id: "f9", kind: "separateFaces", source: "body1",
          pieces: [{ body: "body1", from: 6, count: 6 }, { body: "body2", from: 0, count: 6 }],
        }],
      },
    });
    expect(r.real.faceMaterialId("body2", 2)).toBe("m-steel");
    expect(r.real.faceMaterialId("body1", 1)).toBe("m-steel");
    expect(r.real.faceMaterialId("body1", 2)).toBeUndefined();
    expect(r.real.faceMaterialId("body1", 7)).toBeUndefined();
    r.real.undo();
    expect(r.real.faceMaterialId("body2", 2)).toBeUndefined();
    expect(r.real.faceMaterialId("body1", 2)).toBe("m-steel");
    expect(r.real.faceMaterialId("body1", 7)).toBe("m-steel");
    expect(r.real.faceMaterialId("body1", 1)).toBeUndefined();
  });

  it("stops waiting when the feature fails", async () => {
    const r = rig();
    await r.starters.startSeparate();
    r.fire({ building: false, errorFeatureId: "f9", result: { bodies: r.bodies } });
    r.fire({ building: false, errorFeatureId: null, result: { bodies: [...r.bodies, { id: "body2", name: "Body1 2" }] } });
    expect(r.real.bodyColorSlot("body2")).toBeUndefined();
  });
});
