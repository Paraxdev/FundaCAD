// Face materials through a replacing load (a version restore, an assistant's edit) and its undo, on two bodies,
// while a fillet, a dimension edit or a Separate renumbers the faces under them (numbers in faceRefs.test.ts).
import { describe, expect, it, vi } from "vitest";
import { DocumentStore } from "../../src/document/store";
import type { CadDocument, Feature, RebuildResult } from "../../src/types";
import type { GeometryBackend } from "../../src/geometry/client";
import { reply, runs, separated, type Scenario } from "./faceRefsFixture";

vi.stubGlobal("window", globalThis);

const DOC: CadDocument = {
  parameters: {},
  features: [{ id: "s1", type: "sketch", plane: "XY", entities: [] }] as Feature[],
};
const step = (id: string) => ({ id, type: "fillet", edges: [], radius: 1.5 }) as unknown as Feature;
const FILLET = step("fl1");

const BASE = { "body1#0": "m-steel", "body1#4": "m-brass", "body1#5": "m-glass", "body2#1": "m-brass", "body2#4": "m-glass" };
const FILLETED = { "body1#5": "m-steel", "body1#4": "m-brass", "body1#8": "m-glass", "body2#1": "m-brass", "body2#4": "m-glass" };

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

async function painted() {
  const kit = await opened("base");
  const { store, built } = kit;
  store.setFacesMaterial([{ body: "body1", face: 0 }], "m-steel");
  store.setFacesMaterial([{ body: "body1", face: 4 }, { body: "body2", face: 1 }], "m-brass");
  store.setFacesMaterial([{ body: "body1", face: 5 }, { body: "body2", face: 4 }], "m-glass");
  expect(entries(store)).toEqual(BASE);
  const fillet = async () => {
    store.addFeature(structuredClone(FILLET));
    await built("fillet");
  };
  return { ...kit, fillet };
}

describe("undo of a version restore with face materials", () => {
  it("brings back the paint done after the version on the filleted faces, and redo the version's", async () => {
    const { store, built, fillet } = await painted();
    const v1 = store.saveVersion("painted")!;
    await fillet();
    store.setFacesMaterial([{ body: "body1", face: 2 }], "m-copper");
    store.setFacesMaterial([{ body: "body2", face: 1 }], "m-gold");
    const before = { ...FILLETED, "body1#2": "m-copper", "body2#1": "m-gold" };
    expect(entries(store)).toEqual(before);

    store.restoreVersion(v1.id);
    await built("base");
    expect(entries(store)).toEqual(BASE);
    store.undo();
    await built("fillet");
    expect(entries(store)).toEqual(before);
    expect(JSON.parse(store.toJSON()).faceMaterials).toEqual(before);

    store.redo();
    await built("base");
    expect(entries(store)).toEqual(BASE);
    store.undo();
    await built("fillet");
    expect(entries(store)).toEqual(before);

    store.undo();
    store.undo();
    expect(entries(store)).toEqual(FILLETED);
    store.undo();
    await built("base");
    expect(entries(store)).toEqual(BASE);
  });

  it("does the same for an undo before the restored build arrives, the faces read in between", async () => {
    const { store, built, fillet } = await painted();
    const v1 = store.saveVersion("painted")!;
    await fillet();
    store.setFacesMaterial([{ body: "body1", face: 2 }], "m-copper");
    const before = { ...FILLETED, "body1#2": "m-copper" };
    store.restoreVersion(v1.id);
    store.undo();
    entries(store);
    await built("fillet");
    expect(entries(store)).toEqual(before);
  });

  it("puts the materials back with their prints, read while the restored build is still on screen", async () => {
    const { store, built, fillet } = await painted();
    store.setFacesMaterial([{ body: "body1", face: 0 }, { body: "body1", face: 5 }, { body: "body2", face: 4 }], null);
    const v1 = store.saveVersion("brass")!;
    store.setFacesMaterial([{ body: "body1", face: 0 }], "m-steel");
    await fillet();
    const before = { "body1#4": "m-brass", "body1#5": "m-steel", "body2#1": "m-brass" };
    expect(entries(store)).toEqual(before);
    store.restoreVersion(v1.id);
    await built("base");
    store.undo();
    entries(store);
    await built("fillet");
    expect(entries(store)).toEqual(before);
  });

  it("keeps every face material on its face when nothing was painted since the version", async () => {
    const { store, built, fillet } = await painted();
    const v1 = store.saveVersion("painted")!;
    await fillet();
    store.restoreVersion(v1.id);
    await built("base");
    expect(entries(store)).toEqual(BASE);
    store.undo();
    await built("fillet");
    expect(entries(store)).toEqual(FILLETED);
    expect(JSON.parse(store.toJSON()).faceMaterials).toEqual(FILLETED);
  });
});

describe("undo of an assistant's edit with face materials", () => {
  async function edited() {
    const kit = await painted();
    const sent = kit.store.toObject() as CadDocument & { faceMaterials: Record<string, string> };
    kit.box.result = reply("fillet");
    kit.store.loadDocument({
      ...sent,
      features: [...sent.features, structuredClone(FILLET)],
      faceMaterials: { ...sent.faceMaterials, "body1#0": "m-gold" },
    } as CadDocument, { replace: true });
    await kit.built("fillet");
    const edit = { ...FILLETED, "body1#5": "m-gold" };
    expect(entries(kit.store)).toEqual(edit);
    return { ...kit, edit };
  }

  it("takes back the paint and the fillet the edit brought, and redo brings them again", async () => {
    const { store, built, edit } = await edited();
    store.undo();
    await built("base");
    expect(entries(store)).toEqual(BASE);
    store.redo();
    await built("fillet");
    expect(entries(store)).toEqual(edit);
  });

  it("keeps a material taken off the model after the edit", async () => {
    const { store, built } = await edited();
    store.unassignMaterials(["m-gold"]);
    store.undo();
    await built("base");
    const { "body1#0": _, ...rest } = BASE;
    expect(entries(store)).toEqual(rest);
  });
});

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
    store.undo();
    await built("hole");
    expect(entries(store)).toEqual({ "body1#9": "m-glass" });
  });
});

describe("undo of a replacing load with face materials a dimension edit moved", () => {
  const moved = { "body1#1": "m-steel", "body1#2": "m-brass", "body2#2": "m-brass" };
  async function paintedThenDeepened(first: Scenario) {
    const kit = await opened(first);
    const v0 = kit.store.saveVersion("plain")!;
    if (first !== "base") await kit.edit("f0", "base");
    kit.store.setFacesMaterial([{ body: "body1", face: 1 }], "m-steel");
    kit.store.setFacesMaterial([{ body: "body1", face: 5 }, { body: "body2", face: 2 }], "m-brass");
    kit.store.setFacesMaterial([{ body: "body9", face: 2 }], "m-steel");
    await kit.edit("f1", "deep");
    expect(entries(kit.store)).toEqual(moved);
    return { ...kit, v0 };
  }

  it("puts them back on the faces they had moved to, read only once the build is back", async () => {
    const { store, built, v0 } = await paintedThenDeepened("base");
    store.restoreVersion(v0.id);
    await built("base");
    expect(entries(store)).toEqual({});
    store.undo();
    await built("deep");
    expect(entries(store)).toEqual(moved);
    expect(JSON.parse(store.toJSON()).faceMaterials).toEqual({ ...moved, "body9#2": "m-steel" });
    store.undo();
    await built("base");
    expect(entries(store)).toEqual({ "body1#1": "m-steel", "body1#5": "m-brass", "body2#2": "m-brass" });
  });

  it("does the same over a version built on the moved faces, read while that version is still on screen", async () => {
    const { store, built, v0 } = await paintedThenDeepened("deep");
    store.restoreVersion(v0.id);
    await built("deep");
    expect(entries(store)).toEqual({});
    store.undo();
    entries(store);
    await built("deep");
    expect(entries(store)).toEqual(moved);
  });

  it("puts back the materials of a document no build has shown yet as they were saved", async () => {
    const { store, box } = await opened("base");
    const saved = { "body1#4": "m-brass", "body2#1": "m-glass", "body9#2": "m-steel" };
    store.load(JSON.stringify({ ...DOC, faceMaterials: saved }));
    const sent = store.toObject() as CadDocument;
    const edit = { ...sent, features: [...sent.features, FILLET], faceMaterials: { "body1#0": "m-gold" } };
    store.loadDocument(edit as unknown as CadDocument, { replace: true });
    store.undo();
    box.result = reply("base");
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#4": "m-brass", "body2#1": "m-glass" });
    expect(JSON.parse(store.toJSON()).faceMaterials).toEqual(saved);
  });
});

describe("undo of a version restore over a Separate", () => {
  it("gives each piece its materials back, and the undo of the Separate takes them back to the body", async () => {
    const { store, built, shown } = await opened("base");
    const [lower, upper] = [[0, 1, 2, 3, 4], [5, 6, 7, 8]];
    store.setFacesMaterial([{ body: "body1", face: 1 }], "m-steel");
    store.setFacesMaterial([{ body: "body1", face: 6 }], "m-brass");
    store.setFacesMaterial([{ body: "body1", face: 7 }, { body: "body2", face: 4 }], "m-glass");
    const whole = { "body1#1": "m-steel", "body1#6": "m-brass", "body1#7": "m-glass", "body2#4": "m-glass" };
    const v1 = store.saveVersion("whole")!;
    store.addFeature(step("sep"));
    await shown(separated("base", lower, upper));
    store.inheritBodyLook("body1", runs(lower, upper));
    const pieces = { "body1#1": "m-steel", "body3#1": "m-brass", "body3#2": "m-glass", "body2#4": "m-glass" };
    expect(entries(store)).toEqual(pieces);

    store.restoreVersion(v1.id);
    await built("base");
    expect(entries(store)).toEqual(whole);
    store.undo();
    await shown(separated("base", lower, upper));
    expect(entries(store)).toEqual(pieces);
    store.undo();
    expect(entries(store)).toEqual({ "body1#1": "m-steel", "body2#4": "m-glass" });
    store.undo();
    await built("base");
    expect(entries(store)).toEqual(whole);
    store.redo();
    await shown(separated("base", lower, upper));
    store.redo();
    expect(entries(store)).toEqual(pieces);
  });
});
