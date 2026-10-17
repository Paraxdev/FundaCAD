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
    inheritBodyLook: (a: string, b: string, n?: string) => real.inheritBodyLook(a, b, n),
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

  it("stops waiting when the feature fails", async () => {
    const r = rig();
    await r.starters.startSeparate();
    r.fire({ building: false, errorFeatureId: "f9", result: { bodies: r.bodies } });
    r.fire({ building: false, errorFeatureId: null, result: { bodies: [...r.bodies, { id: "body2", name: "Body1 2" }] } });
    expect(r.real.bodyColorSlot("body2")).toBeUndefined();
  });
});
