// Face materials through a replacing load (a version restore, an assistant's edit) and its undo, on two bodies,
// while a fillet, a dimension edit or a Separate renumbers the faces under them (numbers in faceRefs.test.ts).
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { reply, type Scenario } from "./faceRefsFixture";

vi.stubGlobal("window", globalThis);

const DOC: CadDocument = {
  parameters: {},
  features: [{ id: "s1", type: "sketch", plane: "XY", entities: [] }] as Feature[],
};
const step = (id: string) => ({ id, type: "fillet", edges: [], radius: 1.5 }) as unknown as Feature;

const entries = (s: DocumentStore) => Object.fromEntries(s.faceMaterialEntries());

async function opened(first: Scenario) {
  const box = { result: reply(first) as RebuildResult };
  const be = {
    async rebuild() { return { ok: true, result: box.result }; },
    async init() {},
    onStatus() { return () => {}; },
    connected: true,
  } as unknown as GeometryBackend;
  const store = new DocumentStore(be, structuredClone(DOC));
  const shown = async (result: RebuildResult) => {
    box.result = result;
    await store.rebuildNow();
  };
  const built = (name: Scenario) => shown(reply(name));
  const edit = async (id: string, name: Scenario) => {
    store.addFeature(step(id));
    await built(name);
  };
  await built(first);
  return { store, box, built, shown, edit };
}

describe("a replacing load puts face materials where opening its document does", () => {
  it("restores a version with a slot over the model the slot was taken out of, and a second document gets none", async () => {
    const { store, built, edit } = await opened("slot");
    store.setFacesMaterial([{ body: "body1", face: 6 }], "m-steel");
    store.setFacesMaterial([{ body: "body2", face: 3 }], "m-brass");
    const v1 = store.saveVersion("slot")!;
    await edit("f1", "base");
    expect(entries(store)).toEqual({ "body1#7": "m-steel", "body2#3": "m-brass" });
    store.restoreVersion(v1.id);
    await built("slot");
    const want = { "body1#6": "m-steel", "body2#3": "m-brass" };
    expect(entries(store)).toEqual(want);
    expect(JSON.parse(store.toJSON()).faceMaterials).toEqual(want);

    store.load(JSON.stringify({ ...DOC, faceMaterials: { "body2#2": "m-copper" } }));
    await built("base");
    expect(entries(store)).toEqual({ "body2#2": "m-copper" });
  });

  it("gives an assistant's materials without prints the faces of the build its edit makes", async () => {
    const { store, built } = await opened("hole");
    store.setFacesMaterial([{ body: "body1", face: 9 }], "m-glass");
    const sent = store.toObject() as CadDocument;
    store.loadDocument({
      ...sent,
      features: [...sent.features, step("rim")],
      faceMaterials: { "body1#1": "m-gold", "body2#2": "m-steel" },
    } as unknown as CadDocument, { replace: true });
    await built("holeRim");
    expect(entries(store)).toEqual({ "body1#1": "m-gold", "body2#2": "m-steel" });
  });
});
