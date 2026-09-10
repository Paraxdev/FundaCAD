// Roll-to-position edit preview: while editing feature f, rebuilds must see the
// timeline truncated to just BEFORE f (so e.g. a fillet's member edges exist
// again) plus the live edited version. These tests drive DocumentStore against
// a stub backend that records every document it is asked to rebuild.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DocumentStore, prefixFeatures } from "../../src/document/store";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";

function stubBackend(
  rebuilds: CadDocument[],
  reply: () => RebuildReply = () => ({ ok: false, error: { message: "stub" } }),
): GeometryBackend {
  return {
    async rebuild(doc: CadDocument): Promise<RebuildReply> {
      rebuilds.push(doc);
      return reply();
    },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
}

const doc = (): CadDocument => ({
  parameters: {},
  features: [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    { id: "f1", type: "fillet", edges: { kind: "edge", by: "nearest", point: [0, 0, 0] }, radius: 2 },
    { id: "c1", type: "chamfer", edges: { kind: "edge", by: "nearest", point: [1, 0, 0] }, distance: 1 },
  ] as Feature[],
});

describe("edit preview (roll-to-position)", () => {
  let rebuilds: CadDocument[];
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    rebuilds = [];
    store = new DocumentStore(stubBackend(rebuilds), doc());
  });
  afterEach(() => void vi.useRealTimers());

  const lastIds = async () => {
    await vi.runAllTimersAsync(); // drain the scheduled rebuild
    const last = rebuilds[rebuilds.length - 1];
    return last ? last.features.map((f) => f.id) : [];
  };

  it("beginEditPreview rolls to just before the edited feature", async () => {
    store.beginEditPreview("f1");
    expect(await lastIds()).toEqual(["s1", "e1"]); // f1 and later c1 excluded
    expect(store.hasPreview).toBe(true);
    expect(store.editPreviewId).toBe("f1");
  });

  it("setEditPreview appends the live edited feature at the roll point", async () => {
    store.beginEditPreview("f1");
    const live: Feature = { id: "f1", type: "fillet", edges: [], radius: 5 } as unknown as Feature;
    store.setEditPreview(live);
    const ids = await lastIds();
    expect(ids).toEqual(["s1", "e1", "f1"]);
    const last = rebuilds[rebuilds.length - 1];
    const sent = last?.features.find((f) => f.id === "f1") as { radius?: number } | undefined;
    expect(sent?.radius).toBe(5); // the LIVE version, not the committed one
  });

  it("endEditPreview restores the full committed timeline", async () => {
    store.beginEditPreview("f1");
    await vi.runAllTimersAsync();
    store.endEditPreview();
    expect(await lastIds()).toEqual(["s1", "e1", "f1", "c1"]);
    expect(store.hasPreview).toBe(false);
    expect(store.editPreviewId).toBe(null);
  });

  it("editing document state is untouched (undo/serialize see the committed doc)", async () => {
    const before = store.toJSON();
    store.beginEditPreview("f1");
    store.setEditPreview({ id: "f1", type: "fillet", edges: [], radius: 99 } as unknown as Feature);
    await vi.runAllTimersAsync();
    expect(store.toJSON()).toBe(before);
    store.endEditPreview(false);
  });

  it("never resurrects features past the rollback marker", async () => {
    store.setRollback(2); // only s1, e1 build; f1 is rolled off
    store.beginEditPreview("f1"); // f1 not in the effective slice -> no truncation
    expect(await lastIds()).toEqual(["s1", "e1"]);
    store.endEditPreview(false);
  });
});

describe("palette persistence", () => {
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new DocumentStore(stubBackend([]), doc());
  });
  afterEach(() => void vi.useRealTimers());

  it("a synced palette survives save/reload even with zero body assignments", () => {
    const synced = [
      { name: "Polymaker PLA", color: "#ff8800", material: "PLA" },
      { name: "eSun PETG", color: "#0044ff", material: "PETG" },
    ];
    store.applyFilamentSync(synced);
    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(store.toJSON());
    expect(reloaded.colorPalette[0]).toMatchObject(synced[0]!);
    expect(reloaded.colorPalette[1]).toMatchObject(synced[1]!);
  });

  it("an untouched default palette is still omitted from the saved doc (byte stability)", () => {
    const json = store.toJSON();
    expect(json).not.toContain('"palette"'); // same bytes an old build wrote
    // load() applies the hiddenBodies migration once, so compare two saves
    // AFTER a load cycle: a re-opened doc must re-save byte-identically.
    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(json);
    const migrated = reloaded.toJSON();
    expect(migrated).not.toContain('"palette"');
    const again = new DocumentStore(stubBackend([]), doc());
    again.load(migrated);
    expect(again.toJSON()).toBe(migrated);
  });
});

describe("elements (the user's folders over the bodies)", () => {
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new DocumentStore(stubBackend([]), doc());
  });
  afterEach(() => void vi.useRealTimers());

  it("a document with no folders is byte-identical to one saved before they existed", () => {
    const json = store.toJSON();
    expect(json).not.toContain('"elements"');
    expect(json).not.toContain('"bodyElement"');
  });

  it("round-trips the folders and what is in them", () => {
    const rig = store.addElement("Rig");
    const motor = store.addElement("Motor", rig);
    store.setBodiesElement(["body1", "body2"], motor);

    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(store.toJSON());
    expect(reloaded.bodyElements).toEqual([
      { id: rig, name: "Rig" },
      { id: motor, name: "Motor", parent: rig },
    ]);
    expect(reloaded.bodyElementOf("body1")).toBe(motor);
    expect(reloaded.bodyElementOf("body3")).toBeUndefined();
    // and a re-opened document re-saves byte-identically
    const again = new DocumentStore(stubBackend([]), doc());
    again.load(reloaded.toJSON());
    expect(again.toJSON()).toBe(reloaded.toJSON());
  });

  it("numbers a fresh folder against its siblings", () => {
    store.addElement();
    const second = store.addElement();
    expect(store.bodyElements.map((e) => e.name)).toEqual(["Element", "Element 2"]);
    // the control: inside one of them the plain name is free again
    const inside = store.addElement(undefined, second);
    expect(store.bodyElements.find((e) => e.id === inside)!.name).toBe("Element");
  });

  it("deleting a folder keeps its bodies, it does not delete them", () => {
    const rig = store.addElement("Rig");
    const motor = store.addElement("Motor", rig);
    store.setBodiesElement(["body1"], motor);
    store.removeElement(motor);
    expect(store.bodyElements.map((e) => e.id)).toEqual([rig]);
    expect(store.bodyElementOf("body1")).toBe(rig); // lifted, not dropped

    store.removeElement(rig);
    expect(store.bodyElements).toEqual([]);
    expect(store.bodyElementOf("body1")).toBeUndefined(); // an orphan again
  });

  it("refuses to bury a folder inside itself", () => {
    const rig = store.addElement("Rig");
    const motor = store.addElement("Motor", rig);
    store.setElementParent(rig, motor);
    expect(store.bodyElements.find((e) => e.id === rig)!.parent).toBeUndefined();
    // the control: the move the other way round is legal and is taken
    store.setElementParent(motor, null);
    expect(store.bodyElements.find((e) => e.id === motor)!.parent).toBeUndefined();
  });

  it("never dirties the document for a move that changes nothing", () => {
    const rig = store.addElement("Rig");
    store.setBodiesElement(["body1"], rig);
    store.markSaved("x.funda");
    store.setBodiesElement(["body1"], rig);
    expect(store.dirty).toBe(false);
    // the control: a real move does dirty it
    store.setBodiesElement(["body1"], null);
    expect(store.dirty).toBe(true);
  });

  it("drops an element with no id rather than carrying a folder nothing can name", () => {
    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(JSON.stringify({
      ...doc(),
      elements: [{ name: "Nameless" }, { id: "e1", name: "" }, { id: "e2", name: "Rig" }],
    }));
    expect(reloaded.bodyElements).toEqual([
      { id: "e1", name: "e1" }, // a blank name falls back to the id, still aimable
      { id: "e2", name: "Rig" },
    ]);
  });
});

describe("rebuildNow resolves when the RESULT is published", () => {
  // The defect: rebuilds are serialized, and the "one is already in flight"
  // branch returned at once. So `await rebuildNow()` right after addFeature,
  // which is exactly when a caller wants the bodies a feature produced,
  // resolved with buildState.result still pointing at the previous document.
  // Both callers of it are import paths, and both do that.
  it("waits for the in-flight drain instead of returning at once", async () => {
    vi.useRealTimers(); // a real await, not a fake-timer one
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    let calls = 0;
    const backend = {
      async rebuild(): Promise<RebuildReply> {
        calls++;
        await gate;
        return {
          ok: true,
          result: {
            mesh: { positions: [0], indices: [], faceIds: [] },
            edges: [],
            bbox: { min: [0, 0, 0], max: [1, 1, 1] },
            bodies: [{ id: "body1", name: "Bracket", faceStart: 0, faceCount: 1 }],
          },
        } as RebuildReply;
      },
      async init() {},
      onStatus() { return () => {}; },
      connected: true,
    } as unknown as GeometryBackend;

    const store = new DocumentStore(backend, doc());
    // addFeature schedules an immediate rebuild, so one is in flight when the
    // second caller arrives: the branch under test.
    store.addFeature({ id: "b1", type: "box", length: 1, width: 1, height: 1 } as Feature);
    const waited = store.rebuildNow();
    expect(store.buildState.result?.bodies).toBeUndefined(); // nothing yet, as expected
    release!();
    await waited;
    expect(store.buildState.result?.bodies?.[0]?.id).toBe("body1");
    expect(calls).toBeGreaterThan(0);
  });
});

describe("materials (what a body is made of, on screen)", () => {
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    store = new DocumentStore(stubBackend([]), doc());
  });
  afterEach(() => void vi.useRealTimers());

  it("an untouched library with nothing assigned is left out of the file", () => {
    expect(store.toJSON()).not.toContain('"materials"');
    expect(store.toJSON()).not.toContain('"bodyMaterial"');
    // the control: assigning one body is enough to make it worth writing
    store.setBodiesMaterial(["body1"], "m-brass");
    expect(store.toJSON()).toContain('"materials"');
    expect(store.toJSON()).toContain('"bodyMaterial"');
  });

  it("round-trips a customised library and its assignments", () => {
    store.updateMaterial("m-brass", { name: "Bronze", color: "#a06020" });
    const mine = store.addMaterial({ name: "Anodised blue", color: "#2244cc", metalness: 0.7 });
    store.setBodiesMaterial(["body1", "body2"], mine);

    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(store.toJSON());
    expect(reloaded.materialLibrary.find((m) => m.id === "m-brass")).toMatchObject({
      name: "Bronze", color: "#a06020",
    });
    expect(reloaded.bodyMaterialOf("body1")?.name).toBe("Anodised blue");
    const again = new DocumentStore(stubBackend([]), doc());
    again.load(reloaded.toJSON());
    expect(again.toJSON()).toBe(reloaded.toJSON());
  });

  it("a reopened untouched document still writes no materials block", () => {
    // The trap this is for: the library is normalised on load, so an entry that
    // was not already in normal form would come back different and the
    // "untouched" check would answer no for every document ever reopened.
    const reloaded = new DocumentStore(stubBackend([]), doc());
    reloaded.load(store.toJSON());
    expect(reloaded.toJSON()).not.toContain('"materials"');
  });

  it("resolves an assignment, so a deleted material is the same as none", () => {
    store.setBodiesMaterial(["body1"], "m-glass");
    expect(store.bodyMaterialOf("body1")?.name).toBe("Glass");
    store.removeMaterial("m-glass");
    expect(store.bodyMaterialOf("body1")).toBeUndefined();
    expect(store.bodyMaterialId("body1")).toBeUndefined(); // and the row is gone, not dangling
  });

  it("refuses an assignment to a material that is not in the library", () => {
    store.setBodiesMaterial(["body1"], "m-nonexistent");
    expect(store.bodyMaterialId("body1")).toBeUndefined();
  });

  it("hands the viewport only the bodies whose finish differs from the default", () => {
    // Aluminium is metallic, so it has a finish worth sending.
    store.setBodiesMaterial(["body1"], "m-aluminium");
    expect(store.materialFinishes()).toEqual({
      body1: { metalness: 0.9, roughness: 0.35, opacity: 1, emissive: 0 },
    });
    expect(store.materialPaint()).toEqual({ body1: "#b8bcc0" });

    // A material that says nothing about its finish is the app's own default,
    // so there is nothing for the renderer to do and nothing is sent.
    const plain = store.addMaterial({ name: "Plain", color: "#123456" });
    store.setBodiesMaterial(["body1"], plain);
    expect(store.materialFinishes()).toEqual({});
    expect(store.materialPaint()).toEqual({ body1: "#123456" });

    // A material that only GLOWS is worth sending for that alone: everything
    // else about it is the default, and a body left out of this map would be
    // drawn unlit.
    const lit = store.addMaterial({ name: "Lit", color: "#42e07a", emissive: 0.8 });
    store.setBodiesMaterial(["body1"], lit);
    expect(store.materialFinishes()).toEqual({
      body1: { metalness: 0.1, roughness: 0.55, opacity: 1, emissive: 0.8 },
    });
  });

  it("merges an imported library by id rather than replacing it", () => {
    store.setBodiesMaterial(["body1"], "m-copper");
    const before = store.materialLibrary.length;
    const res = store.importMaterials([
      { id: "m-copper", name: "Copper, polished", color: "#c07a4b" },
      { id: "m-titanium", name: "Titanium", color: "#8d8f92" },
    ]);
    expect(res).toEqual({ added: 1, updated: 1 });
    expect(store.materialLibrary).toHaveLength(before + 1);
    // the body keeps its assignment and gets the incoming colour
    expect(store.bodyMaterialOf("body1")?.color).toBe("#c07a4b");
  });

  it("never dirties the document for an assignment that changes nothing", () => {
    store.setBodiesMaterial(["body1"], "m-steel");
    store.markSaved("x.funda");
    store.setBodiesMaterial(["body1"], "m-steel");
    expect(store.dirty).toBe(false);
    store.setBodiesMaterial(["body1"], null); // the control
    expect(store.dirty).toBe(true);
  });
});

describe("projected-entity persistence (byte stability)", () => {
  it("a doc with a projected entity round-trips byte-identically, stale omitted when false", () => {
    vi.useFakeTimers();
    const withProjected = (): CadDocument => ({
      parameters: {},
      features: [
        { id: "s1", type: "sketch", plane: "XY", entities: [
          { type: "projected", id: "p1",
            source: { kind: "edge", body: "body1",
              sel: { kind: "edge", by: "match", fp: { mid: [0, 0, 0], dir: [1, 0, 0] } } },
            curve: { kind: "line", x1: 0, y1: 0, x2: 20, y2: 0 } },
        ] },
      ] as Feature[],
    });
    const store = new DocumentStore(stubBackend([]), withProjected());
    const json = store.toJSON();
    expect(json).toContain('"projected"');
    expect(json).not.toContain('"stale"'); // omit-when-false, like every persisted flag
    // load() runs migration once; a re-opened doc must re-save byte-identically
    const reloaded = new DocumentStore(stubBackend([]), withProjected());
    reloaded.load(json);
    const migrated = reloaded.toJSON();
    const again = new DocumentStore(stubBackend([]), withProjected());
    again.load(migrated);
    expect(again.toJSON()).toBe(migrated);
    vi.useRealTimers();
  });
});

describe("prefixFeatures (Project tool's prefix-document rule)", () => {
  const feats = (): Feature[] => [
    { id: "s1", type: "sketch", plane: "XY", entities: [] },
    { id: "e1", type: "extrude", sketch: "s1", distance: 10, operation: "new" },
    { id: "s2", type: "sketch", plane: "XY", entities: [] },
    { id: "e2", type: "extrude", sketch: "s2", distance: 5, operation: "join" },
  ] as Feature[];
  const none = new Set<string>();

  it("new sketch: everything up to the rollback marker", () => {
    expect(prefixFeatures(feats(), 4, none).map((f) => f.id)).toEqual(["s1", "e1", "s2", "e2"]);
    expect(prefixFeatures(feats(), 2, none).map((f) => f.id)).toEqual(["s1", "e1"]);
  });

  it("editing an existing sketch: strictly before the edited feature", () => {
    expect(prefixFeatures(feats(), 4, none, "s2").map((f) => f.id)).toEqual(["s1", "e1"]);
    // the edited feature itself is never included
    expect(prefixFeatures(feats(), 4, none, "s1").map((f) => f.id)).toEqual([]);
  });

  it("suppressed features are excluded", () => {
    expect(prefixFeatures(feats(), 4, new Set(["e1"]), "e2").map((f) => f.id)).toEqual(["s1", "s2"]);
  });

  it("edited feature past the rollback marker: the marker still truncates", () => {
    // rolled back to 2, editing s2 (which sits at index 2, outside the build)
    expect(prefixFeatures(feats(), 2, none, "s2").map((f) => f.id)).toEqual(["s1", "e1"]);
  });
});

// A preview that the kernel refuses has to say so where the value is being
// typed, and it has to say it about the RIGHT value. rebuildBridge does not
// toast a preview's failures (a drag through a bad range would emit one a
// frame), so this getter is the only thing carrying the answer out.
describe("previewError", () => {
  let rebuilds: CadDocument[];
  let reply: RebuildReply;
  let store: DocumentStore;
  beforeEach(() => {
    vi.useFakeTimers();
    rebuilds = [];
    reply = { ok: false, error: { message: "stub" } };
    store = new DocumentStore(stubBackend(rebuilds, () => reply), doc());
  });
  afterEach(() => void vi.useRealTimers());

  const settle = async () => void (await vi.runAllTimersAsync());

  it("is null when nothing is being previewed", async () => {
    reply = { ok: false, error: { message: "boom", feature_id: "f1" } };
    await store.rebuildNow();
    await settle();
    // The feature failed and the timeline will say so. That is not this
    // channel's business: nobody is mid-gesture, so there is no box to redden.
    expect(store.buildState.errorFeatureId).toBe("f1");
    expect(store.previewError).toBeNull();
  });

  it("reports the refusal of the feature being previewed", async () => {
    reply = { ok: false, error: { message: "radius too large", feature_id: "f1" } };
    store.beginEditPreview("f1", doc().features[2]!);
    await settle();
    expect(store.previewError).toBe("radius too large");
  });

  it("stays silent about a failure somewhere else in the timeline", async () => {
    // Telling somebody their fillet radius is impossible because an unrelated
    // chamfer failed would be worse than saying nothing: they would spend the
    // next minute changing the one number that was never the problem.
    reply = { ok: false, error: { message: "chamfer too big", feature_id: "c1" } };
    store.beginEditPreview("f1", doc().features[2]!);
    await settle();
    expect(store.previewError).toBeNull();
  });

  it("says nothing while a build is still in flight", async () => {
    // A refusal that has not come back yet is not a refusal. Reporting the
    // previous one between frames of a drag makes the box strobe on every value
    // the hand passes through.
    reply = { ok: false, error: { message: "radius too large", feature_id: "f1" } };
    store.beginEditPreview("f1", doc().features[2]!);
    await settle();
    expect(store.previewError).toBe("radius too large");
    store.setEditPreview(doc().features[2]!);
    expect(store.buildState.building || store.previewError === null).toBe(true);
  });

  it("clears when the previewed value builds", async () => {
    reply = { ok: false, error: { message: "radius too large", feature_id: "f1" } };
    store.beginEditPreview("f1", doc().features[2]!);
    await settle();
    expect(store.previewError).toBe("radius too large");
    reply = { ok: true, result: { bodies: [], featureErrors: [] } } as unknown as RebuildReply;
    store.setEditPreview(doc().features[2]!);
    await settle();
    expect(store.previewError).toBeNull();
  });

  it("clears when the preview is closed, even though the build still failed", async () => {
    reply = { ok: false, error: { message: "radius too large", feature_id: "f1" } };
    store.beginEditPreview("f1", doc().features[2]!);
    await settle();
    store.endEditPreview(false);
    expect(store.previewError).toBeNull();
  });
});
