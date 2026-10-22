// A mirror across a flat face writes a datum plane and the mirror together, so one undo takes both away.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import { mirrorFeatures } from "../../src/features/mirrorMath";
import { freshIds } from "../../src/features/moveTarget";
import type { CadDocument, Feature, RebuildReply } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import type { FacePlanePick } from "../../src/features/facePlanePick";

vi.stubGlobal("window", globalThis);

const backend = {
  async rebuild(): Promise<RebuildReply> {
    return { ok: false, error: { message: "stub" } };
  },
  async init() {},
  onStatus: () => () => {},
  connected: true,
} as unknown as GeometryBackend;

const doc = (ids: string[]): CadDocument => ({
  parameters: {},
  features: [
    { id: ids[0]!, type: "sketch", plane: "XY", entities: [] },
    { id: ids[1]!, type: "extrude", sketch: ids[0]!, distance: 12.5, operation: "new" },
  ] as Feature[],
});

const FACE: FacePlanePick = {
  def: { origin: [14, -3, 6.25], normal: [0.8, 0.6, 0], xdir: [-0.6, 0.8, 0] },
  kind: "planar",
  selector: { kind: "face", by: "nearest", point: [14, -3, 6.25], body: "body1" },
  faceId: 7,
  at: [14, -3, 6.25],
};

function commit(store: DocumentStore, bodies: string[]) {
  const ids = freshIds(store, 2);
  store.addFeatures(mirrorFeatures(() => ids.shift()!, bodies, { kind: "face", face: FACE }));
}

describe("a face mirror in the store", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("adds the datum and the mirror as one undo step", () => {
    const store = new DocumentStore(backend, doc(["s1", "e1"]));
    const before = store.toJSON();
    commit(store, ["body1"]);
    expect(store.document.features.slice(2)).toEqual([
      { id: "f3", type: "datumPlane", plane: FACE.def, offset: 0, face: FACE.selector, name: "Mirror plane" },
      { id: "f4", type: "mirror", plane: { name: "f3" }, bodies: ["body1"] },
    ]);
    store.undo();
    expect(store.toJSON()).toBe(before);
    store.redo();
    expect(store.document.features.map((f) => f.id)).toEqual(["s1", "e1", "f3", "f4"]);
  });

  it("a second document gets ids of its own", () => {
    const store = new DocumentStore(backend, doc(["s1", "e1"]));
    commit(store, ["body1"]);
    store.load(JSON.stringify(doc(["f1", "f3"])), { replace: true });
    commit(store, ["body2", "body1"]);
    expect(store.document.features.map((f) => f.id)).toEqual(["f1", "f3", "f4", "f5"]);
    expect(store.document.features[3]).toEqual({
      id: "f5",
      type: "mirror",
      plane: { name: "f4" },
      bodies: ["body2", "body1"],
    });
  });
});
