// Face materials in the store follow their faces through a rebuild that reorders
// OCCT's face list, on two bodies, through a save, a reload and an undo.
// Face numbers are the measured ones listed in faceRefs.test.ts.
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { reply } from "./faceRefsFixture";

vi.stubGlobal("window", globalThis);

const DOC: CadDocument = {
  parameters: {},
  features: [{ id: "s1", type: "sketch", plane: "XY", entities: [] }] as Feature[],
};

function opened(json?: string) {
  const box = { result: reply("base") as RebuildResult };
  const be = {
    async rebuild() { return { ok: true, result: box.result }; },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
  const store = new DocumentStore(be, structuredClone(DOC));
  if (json) store.load(json);
  return { store, box };
}

const entries = (s: DocumentStore) => Object.fromEntries(s.faceMaterialEntries());

describe("face materials across a fillet", () => {
  it("stay on the faces they were dropped on in both bodies, and the fillet face stays bare", async () => {
    const { store, box } = opened();
    await store.rebuildNow();
    store.setFacesMaterial([{ body: "body1", face: 0 }], "m-steel");
    store.setFacesMaterial([{ body: "body1", face: 4 }, { body: "body2", face: 1 }], "m-brass");
    store.setFacesMaterial([{ body: "body1", face: 5 }, { body: "body2", face: 4 }], "m-glass");
    box.result = reply("fillet");
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#5": "m-steel", "body1#4": "m-brass", "body1#8": "m-glass", "body2#1": "m-brass", "body2#4": "m-glass" });
    expect(store.faceMaterialId("body1", 2)).toBeUndefined();
    expect(store.faceMaterialId("body1", 0)).toBeUndefined();

    store.setFacesMaterial([{ body: "body1", face: 2 }], "m-steel");
    expect(entries(store)).toEqual({ "body1#5": "m-steel", "body1#2": "m-steel", "body1#4": "m-brass", "body1#8": "m-glass", "body2#1": "m-brass", "body2#4": "m-glass" });
    store.undo();
    box.result = reply("base");
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#0": "m-steel", "body1#4": "m-brass", "body1#5": "m-glass", "body2#1": "m-brass", "body2#4": "m-glass" });
  });

  it("a drop on one part of a split face recolours that part only", async () => {
    const { store, box } = opened();
    await store.rebuildNow();
    store.setFacesMaterial([{ body: "body1", face: 7 }], "m-brass");
    box.result = reply("slot");
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#6": "m-brass", "body1#10": "m-brass" });
    store.setFacesMaterial([{ body: "body1", face: 10 }], "m-steel");
    expect(entries(store)).toEqual({ "body1#6": "m-brass", "body1#10": "m-steel" });
    store.setFacesMaterial([{ body: "body1", face: 6 }], null);
    expect(entries(store)).toEqual({ "body1#10": "m-steel" });
    store.undo();
    store.undo();
    expect(entries(store)).toEqual({ "body1#6": "m-brass", "body1#10": "m-brass" });
  });

  it("saves the faces they are on now, and a reload finds them again before and after its first build", async () => {
    const { store, box } = opened();
    await store.rebuildNow();
    store.setFacesMaterial([{ body: "body1", face: 0 }, { body: "body1", face: 7 }], "m-steel");
    box.result = reply("fillet");
    await store.rebuildNow();
    const saved = JSON.parse(store.toJSON());
    expect(saved.faceMaterials).toEqual({ "body1#5": "m-steel", "body1#7": "m-steel" });
    expect(Object.keys(saved.facePrints).sort()).toEqual(["body1#5", "body1#7"]);

    const again = opened(store.toJSON());
    expect(entries(again.store)).toEqual({ "body1#5": "m-steel", "body1#7": "m-steel" });
    again.box.result = reply("fillet");
    await again.store.rebuildNow();
    expect(entries(again.store)).toEqual({ "body1#5": "m-steel", "body1#7": "m-steel" });
    again.box.result = reply("base");
    await again.store.rebuildNow();
    expect(entries(again.store)).toEqual({ "body1#0": "m-steel", "body1#7": "m-steel" });

    again.store.load(JSON.stringify({ ...DOC, faceMaterials: { "body2#3": "m-brass" } }));
    expect(entries(again.store)).toEqual({ "body2#3": "m-brass" });
    again.box.result = reply("fillet");
    await again.store.rebuildNow();
    expect(entries(again.store)).toEqual({ "body2#3": "m-brass" });
    expect(JSON.parse(again.store.toJSON()).faceMaterials).toEqual({ "body2#3": "m-brass" });
  });

  it("a file from before prints keeps its indices on its first build and follows a fillet after it", async () => {
    const { store, box } = opened(JSON.stringify({ ...DOC, version: 10, faceMaterials: { "body1#0": "m-steel", "body1#8": "m-brass" } }));
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#0": "m-steel", "body1#8": "m-brass" });
    box.result = reply("fillet");
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#5": "m-steel", "body1#1": "m-brass" });
  });
});
