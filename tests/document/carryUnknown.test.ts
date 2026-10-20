// A file from a newer version can carry top level data this version has no use
// for. It is kept off the document the engine builds and the undo stack, and
// written back as it came, so the newer version still has it.

import { describe, expect, it, vi } from "vitest";
import { DocumentStore, KNOWN_DOC_KEYS } from "../../src/document/store";
import type { CadDocument, StressStudy } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

vi.stubGlobal("window", globalThis);

const backend = {
  async rebuild() {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus() {
    return () => {};
  },
  connected: true,
} as unknown as GeometryBackend;

function opened(doc: object): DocumentStore {
  const store = new DocumentStore(backend, { parameters: {}, features: [] });
  store.load(JSON.stringify(doc));
  return store;
}

const saved = (store: DocumentStore) => JSON.parse(store.toJSON()) as Record<string, unknown>;

const study: StressStudy = {
  body: "body1",
  supports: [{ id: 1, type: "fixed", faces: [{ kind: "face", by: "nearest", point: [0, 0, 0], body: "body1" }] }],
  loads: [{
    id: 1, kind: "force", faces: [{ kind: "face", by: "nearest", point: [5, 0, 5], body: "body1" }],
    force: 20, direction: "-Z", custom: [0, 0, -1], pressure: 0.1,
  }],
  gravity: { on: false, direction: "-Z" },
  material: "PETG",
  custom: { E: 2000, nu: 0.35, yield: 40, density: 1.2 },
  size: null,
};

const FUTURE = { nested: [1, "two", null], deep: { x: 1.5 } };

describe("top level data this version does not know", () => {
  const base = {
    version: 99,
    parameters: { w: 10 },
    features: [{ id: "b1", type: "box", length: 10, width: 10, height: 10 }],
    futureKey: FUTURE,
  };

  it("is written back unchanged after an edit, an undo and a reload", () => {
    const store = opened(base);
    store.updateFeature("b1", { length: 12 });
    store.undo();
    expect(saved(store)["futureKey"]).toEqual(FUTURE);
    const again = opened(saved(store));
    expect(saved(again)["futureKey"]).toEqual(FUTURE);
  });

  it("is not in the document the engine builds", () => {
    const store = opened(base);
    expect("futureKey" in store.document).toBe(false);
  });

  it("never overrides a key this version owns", () => {
    const store = opened({ ...base, futureKey: undefined });
    expect(saved(store)["version"]).toBe(10);
    expect(Object.keys(saved(store))).not.toContain("futureKey");
  });

  it("is dropped by a new document", () => {
    const store = opened(base);
    store.newDocument();
    expect(saved(store)["futureKey"]).toBeUndefined();
  });

  it("does not let a __proto__ key reach any prototype", () => {
    const store = opened(JSON.parse(`{"features": [], "__proto__": {"polluted": true}}`));
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(saved(store), "__proto__")).toBe(false);
  });

  it("covers every key a fully populated document writes", () => {
    const store = opened({
      parameters: { w: 10 },
      paramDefs: { w: { expr: "10", value: 10, unit: "mm" } },
      paramExtras: { w: { comment: "width" } },
      features: [
        { id: "b1", type: "box", length: 10, width: 10, height: 10 },
        { id: "b2", type: "box", length: 2, width: 2, height: 2 },
      ],
      viewOverrides: { b1: { hidden: true } },
      bodyIds: { "b1:0": "body1", "b2:0": "body2" },
      suppressed: ["b2"],
      rollback: 1,
      sketchVisibility: { s1: false },
      bodyVisibility: { body1: true },
      planeVisibility: { XY: false },
      bodyNames: { body1: "Block" },
      bodyColors: { body1: 1 },
      elements: [{ id: "el1", name: "Frame" }],
      bodyElement: { body1: "el1" },
      materials: [{ id: "m1", name: "Steel", color: "#888888" }],
      bodyMaterial: { body1: "m1" },
      faceMaterials: { "body1:0": "m1" },
      importColorSource: { i1: "faces" },
      stress: study,
      environment: { settings: { exposure: 1 } },
    });
    store.saveVersion("first");
    const written = Object.keys(saved(store));
    expect(written.filter((k) => !KNOWN_DOC_KEYS.has(k))).toEqual([]);
    for (const k of ["stress", "environment", "versions", "elements", "materials", "palette", "rollback"]) {
      expect(written).toContain(k);
    }
  });
});

describe("element fields this version does not know", () => {
  it("survive a load, a rename and a save", () => {
    const store = opened({ features: [], elements: [{ id: "el1", name: "Frame", futureColour: "#123456" }] });
    store.renameElement("el1", "Rack");
    expect(saved(store)["elements"]).toEqual([{ id: "el1", name: "Rack", futureColour: "#123456" }]);
  });
});

describe("a section this version cannot read", () => {
  const newer = { ...study, supports: [{ id: 1, type: "springMount", faces: [], stiffness: 5 }] };

  it("is written back whole while the document has none of its own", () => {
    const store = opened({ features: [], stress: newer });
    expect(store.stressStudy).toBeNull();
    expect(saved(store)["stress"]).toEqual(newer);
  });

  it("gives way to a study made here", () => {
    const store = opened({ features: [], stress: newer });
    store.setStressStudy(study);
    expect(saved(store)["stress"]).toEqual(study);
  });

  it("goes for versions too, and stays out of a snapshot without them", () => {
    const repo = { futureRepo: true, rows: [1, 2] };
    const store = opened({ features: [], versions: repo });
    expect(saved(store)["versions"]).toEqual(repo);
    expect(store.toObject(false)).not.toHaveProperty("versions");
  });

  it("says it holds versions it cannot read until a version made here replaces them", () => {
    const store = opened({ features: [], versions: { futureRepo: true } });
    expect(store.hasUnreadVersions()).toBe(true);
    store.saveVersion("here");
    expect(store.hasUnreadVersions()).toBe(false);
    expect(opened({ features: [] }).hasUnreadVersions()).toBe(false);
  });

  it("comes through the recovery envelope, which is toObject then load", () => {
    const store = opened({ features: [], stress: newer, futureKey: FUTURE });
    const back = opened(JSON.parse(JSON.stringify(store.toObject())) as CadDocument);
    expect(saved(back)["stress"]).toEqual(newer);
    expect(saved(back)["futureKey"]).toEqual(FUTURE);
  });
});

describe("sections of a .fundab this version does not read", () => {
  const carried = [{ kind: 99, name: "future", hash: "0".repeat(32) }];
  const box = { id: "b1", type: "box", length: 1, width: 1, height: 1 };

  it("stay through a replacing load of the same document", () => {
    const store = opened({ parameters: {}, features: [box] });
    store.carriedSections = carried;
    store.loadDocument({ parameters: {}, features: [{ ...box, length: 2 }] } as unknown as CadDocument, { replace: true });
    expect(store.carriedSections).toEqual(carried);
  });

  it("go when a replacing load brings a different document", () => {
    const store = opened({ parameters: {}, features: [box] });
    store.carriedSections = carried;
    store.loadDocument({ parameters: {}, features: [{ ...box, id: "other" }] } as unknown as CadDocument, { replace: true });
    expect(store.carriedSections).toEqual([]);
  });
});
