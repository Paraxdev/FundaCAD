// The Stress panel's study as a document field: what is read back from a file,
// what is dropped, and how the store saves it alongside the model.

import { describe, expect, it } from "vitest";
import { normalizeStressStudy } from "../../src/document/stressStudy";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, StressStudy } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

const study: StressStudy = {
  body: "body1",
  supports: [
    { id: 1, type: "fixed", faces: [{ kind: "face", by: "nearest", point: [0, 0, 0], body: "body1" }] },
    { id: 2, type: "pinned", faces: [{ kind: "face", by: "nearest", point: [5, 0, 3], body: "body1" }] },
  ],
  loads: [{
    id: 1, kind: "force", faces: [{ kind: "face", by: "nearest", point: [50, 0, 5], body: "body1" }],
    force: 20, direction: "-Z", custom: [0, 0, -1], pressure: 0.1,
  }],
  gravity: { on: true, direction: "-Z" },
  material: "PETG",
  custom: { E: 2000, nu: 0.35, yield: 40, density: 1.2 },
  size: null,
};

describe("normalizeStressStudy", () => {
  it("reads a whole study as it is", () => {
    expect(normalizeStressStudy(structuredClone(study))).toEqual(study);
  });

  it("drops what is not a study at all", () => {
    for (const bad of [null, 3, "stress", [], {}, { supports: [], loads: {} }]) {
      expect(normalizeStressStudy(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("drops a study with an unknown support kind, a damaged load or a face that is not one", () => {
    const kinds = structuredClone(study) as unknown as { supports: { type: string }[] };
    kinds.supports[0]!.type = "glued";
    expect(normalizeStressStudy(kinds)).toBeNull();
    expect(normalizeStressStudy({ ...study, loads: ["heavy"] })).toBeNull();
    expect(normalizeStressStudy({ ...study, loads: [{ ...study.loads[0], kind: "torque" }] })).toBeNull();
    expect(normalizeStressStudy({ ...study, loads: [{ ...study.loads[0], direction: "up" }] })).toBeNull();
    const edge = { ...study, supports: [{ id: 1, type: "fixed", faces: [{ kind: "edge", by: "all" }] }] };
    expect(normalizeStressStudy(edge)).toBeNull();
    expect(normalizeStressStudy({ ...study, gravity: { on: true, direction: "down" } })).toBeNull();
    expect(normalizeStressStudy({ ...study, body: 7 })).toBeNull();
  });

  it("drops a study with a selector whose shape the engine and the panel cannot read", () => {
    const damaged: unknown[] = [
      { kind: "face", by: "match" },
      { kind: "face", by: "match", fp: { normal: [1, 0, 0] } },
      { kind: "face", by: "match", fp: { centroid: [0, 0] } },
      { kind: "face", by: "match", fp: { centroid: [0, 0, 0] }, nth: 1.5 },
      { kind: "face", by: "nearest", point: null },
      { kind: "face", by: "nearest", point: [1] },
      { kind: "face", by: "nearest", point: [0, 0, "1"] },
      { kind: "face", by: "normal", dir: [0, Number.NaN, 1] },
      { kind: "face", by: "tracked", point: [0, 0, 0] },
      { kind: "face", by: "somehow", point: [0, 0, 0] },
      { kind: "face", by: "nearest", point: [0, 0, 0], body: 3 },
    ];
    for (const sel of damaged) {
      const s = { ...study, supports: [{ id: 1, type: "fixed", faces: [sel] }] };
      expect(normalizeStressStudy(s), JSON.stringify(sel)).toBeNull();
    }
    // Every face form the engine reads stays, a fingerprint with only its centroid among them.
    const fine = [
      { kind: "face", by: "normal", dir: [0, 0, 1], body: "body1" },
      { kind: "face", by: "tracked", point: [0, 0, 0], normal: [0, 0, 1], body: "body1" },
      { kind: "face", by: "match", fp: { centroid: [70, 0, 57.5], normal: [1, 0, 0], area: 120, surface: "plane" }, nth: 0, body: "body1" },
      { kind: "face", by: "match", fp: { centroid: [0, 0, 0] }, body: "body1" },
    ];
    expect(normalizeStressStudy({ ...study, supports: [{ id: 1, type: "fixed", faces: fine }] })!.supports[0]!.faces).toEqual(fine);
  });

  it("forgives a number that is not one, and fills what an older study leaves out", () => {
    const loose = {
      body: null,
      supports: [{ faces: [] }],
      loads: [{ id: 3, faces: [], force: "", custom: ["x", 1] }],
      material: "PLA",
      custom: { E: "2300" },
      size: -1,
    };
    expect(normalizeStressStudy(loose)).toEqual({
      body: null,
      supports: [{ id: 1, type: "fixed", faces: [] }],
      loads: [{ id: 3, kind: "force", faces: [], force: 100, direction: "into", custom: [0, 1, -1], pressure: 0.1 }],
      gravity: { on: false, direction: "-Z" },
      material: "PLA",
      custom: { E: 2000, nu: 0.35, yield: 40, density: 1.2 },
      size: null,
    });
  });

  it("renumbers rows whose ids repeat, so each can be addressed", () => {
    const twice = { ...study, supports: [study.supports[0], { ...study.supports[1], id: 1 }] };
    expect(normalizeStressStudy(twice)!.supports.map((s) => s.id)).toEqual([1, 2]);
  });

  it("does not share objects with the parsed document", () => {
    const raw = structuredClone(study);
    const got = normalizeStressStudy(raw)!;
    raw.supports[0]!.faces.pop();
    expect(got.supports[0]!.faces).toHaveLength(1);
  });
});

function stubBackend(): GeometryBackend {
  return {
    async rebuild() { return { ok: false, error: { message: "stub" } }; },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const base = (): CadDocument => ({ parameters: {}, features: [] });

describe("the store keeps the study with the document", () => {
  it("saves it, reads it back, and leaves it out until there is one", () => {
    const store = new DocumentStore(stubBackend(), base());
    expect(store.toJSON()).not.toContain('"stress"');
    store.setStressStudy(study);
    const again = new DocumentStore(stubBackend(), base());
    again.load(store.toJSON());
    expect(again.stressStudy).toEqual(study);
    expect(again.toJSON()).toBe(store.toJSON());
  });

  it("opens a file with a damaged study as if it had none", () => {
    const store = new DocumentStore(stubBackend(), base());
    expect(() => store.load(JSON.stringify({ ...base(), stress: { supports: "all of them" } }))).not.toThrow();
    expect(store.stressStudy).toBeNull();
    store.load(JSON.stringify(base()));
    expect(store.stressStudy).toBeNull();
  });

  it("dirties the document only for a real change, and stays off the undo stack", () => {
    const store = new DocumentStore(stubBackend(), base());
    store.setStressStudy(study);
    store.markSaved("x.funda");
    store.setStressStudy(structuredClone(study));
    expect(store.dirty).toBe(false);
    store.setStressStudy({ ...study, material: "PLA" });
    expect(store.dirty).toBe(true);
    expect(store.canUndo).toBe(false);
  });

  it("keeps its own copy of what it is given", () => {
    const store = new DocumentStore(stubBackend(), base());
    const mine = structuredClone(study);
    store.setStressStudy(mine);
    mine.material = "ABS";
    expect(store.stressStudy!.material).toBe("PETG");
  });

  it("is never sent to the engine with the model", () => {
    const store = new DocumentStore(stubBackend(), base());
    store.setStressStudy(study);
    expect("stress" in store.document).toBe(false);
  });

  it("goes with a new document, and travels with a saved version", () => {
    const store = new DocumentStore(stubBackend(), base());
    store.setStressStudy(study);
    store.saveVersion("with a study");
    const v = store.versionRepo!.versions[0]!.id;
    store.setStressStudy(null);
    store.restoreVersion(v);
    expect(store.stressStudy).toEqual(study);
    store.newDocument();
    expect(store.stressStudy).toBeNull();
  });
});

describe("spots in a study", () => {
  const withSpots = (spots: unknown): unknown => {
    const s = structuredClone(study) as unknown as { loads: { spots?: unknown }[] };
    s.loads[0]!.spots = spots;
    return s;
  };

  it("are read back, a missing normal and all", () => {
    const spots = [{ at: [50, 0, 5], radius: 3, normal: [0, 0, 1] }, { at: [40, 0, 5], radius: 2 }];
    expect(normalizeStressStudy(withSpots(spots))!.loads[0]!.spots).toEqual(spots);
  });

  it("are left out of a row that has none", () => {
    expect("spots" in normalizeStressStudy(withSpots([]))!.loads[0]!).toBe(false);
    expect("spots" in normalizeStressStudy(structuredClone(study))!.supports[0]!).toBe(false);
  });

  it("forgive a radius that is not a size, but not a spot with no point", () => {
    expect(normalizeStressStudy(withSpots([{ at: [1, 2, 3], radius: "wide" }]))!.loads[0]!.spots).toEqual([{ at: [1, 2, 3], radius: 5 }]);
    expect(normalizeStressStudy(withSpots([{ at: [1, 2, 3], radius: -1 }]))!.loads[0]!.spots).toEqual([{ at: [1, 2, 3], radius: 5 }]);
    expect(normalizeStressStudy(withSpots([{ radius: 3 }]))).toBeNull();
    expect(normalizeStressStudy(withSpots({ at: [1, 2, 3], radius: 3 }))).toBeNull();
  });
});
