// Face materials in the store follow their faces through a rebuild that reorders
// OCCT's face list, on two bodies, through a save, a reload and an undo.
// Face numbers are the measured ones listed in faceRefs.test.ts.
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

  it("names each one whose face a rebuild took, until the face comes back, and none from a reload", async () => {
    const { store, box } = opened();
    await store.rebuildNow();
    expect(store.hiddenFaceMaterials()).toEqual([]);
    store.setFacesMaterial([{ body: "body1", face: 3 }, { body: "body1", face: 2 }], "m-steel");
    store.setFacesMaterial([{ body: "body1", face: 7 }, { body: "body2", face: 1 }], "m-brass");
    box.result = reply("unstep");
    await store.rebuildNow();
    const lost = store.hiddenFaceMaterials();
    expect(lost).toEqual([expect.any(String), expect.any(String)]);
    expect(new Set(lost).size).toBe(2);
    expect(entries(store)).toEqual({ "body1#4": "m-brass", "body2#1": "m-brass" });

    const unstep = reply("unstep");
    box.result = { ...unstep, bodies: unstep.bodies!.filter((b) => b.id !== "body2") };
    await store.rebuildNow();
    expect(store.hiddenFaceMaterials()).toEqual([...lost, expect.any(String)]);
    box.result = reply("base");
    await store.rebuildNow();
    expect(store.hiddenFaceMaterials()).toEqual([]);
    expect(entries(store)).toEqual({ "body1#3": "m-steel", "body1#2": "m-steel", "body1#7": "m-brass", "body2#1": "m-brass" });

    box.result = reply("unstep");
    await store.rebuildNow();
    const again = opened(store.toJSON());
    again.box.result = reply("unstep");
    await again.store.rebuildNow();
    expect(again.store.hiddenFaceMaterials()).toEqual([]);
    expect(entries(again.store)).toEqual({ "body1#4": "m-brass", "body2#1": "m-brass" });
    again.store.load(JSON.stringify(DOC));
    await again.store.rebuildNow();
    expect(again.store.hiddenFaceMaterials()).toEqual([]);
    expect(entries(again.store)).toEqual({});
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

/** `name` after a Separate of body1: body1 keeps the run `keep` of its faces, a new body3 takes `take`. */
function separated(name: Scenario, keep: number[], take: number[]): RebuildResult {
  const r = reply(name);
  const P = r.mesh.positions, I = r.mesh.indices, F = r.mesh.faceIds;
  const mesh = { positions: [] as number[], indices: [] as number[], faceIds: [] as number[] };
  const bodies: NonNullable<RebuildResult["bodies"]> = [];
  for (const [id, from, olds] of [["body1", "body1", keep], ["body2", "body2", null], ["body3", "body1", take]] as const) {
    const span = r.bodies!.find((b) => b.id === from)!;
    const local = olds ?? [...Array(span.faceCount).keys()];
    const faceStart = bodies.reduce((n, b) => n + b.faceCount, 0);
    const to = new Map(local.map((o, n) => [span.faceStart + o, faceStart + n]));
    F.forEach((f, t) => {
      if (!to.has(f)) return;
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j]!;
        mesh.indices.push(mesh.positions.length / 3);
        mesh.positions.push(P[3 * v]!, P[3 * v + 1]!, P[3 * v + 2]!);
      }
      mesh.faceIds.push(to.get(f)!);
    });
    bodies.push({ id, name: id, faceStart, faceCount: local.length, etag: id === "body2" ? "b2" : `${name}-${id}` });
  }
  return { mesh, edges: [], bbox: r.bbox, bodies };
}

const runs = (keep: number[], take: number[]) => [
  { id: "body1", faces: { from: keep[0]!, count: keep.length } },
  { id: "body3", faces: { from: take[0]!, count: take.length } },
];

describe("face materials through a Separate with the build on screen", () => {
  const lower = [0, 1, 2, 3, 4], upper = [5, 6, 7, 8];
  const cases: [string, number[], number[], [number, string][], Record<string, string>][] = [
    ["none on the source", lower, upper, [], {}],
    ["one", lower, upper, [[7, "m-glass"]], { "body3#2": "m-glass" }],
    ["many, the source keeping the first run", lower, upper, [[1, "m-steel"], [6, "m-brass"], [7, "m-glass"]],
      { "body1#1": "m-steel", "body3#1": "m-brass", "body3#2": "m-glass" }],
    ["many, the source keeping the last run", upper, lower, [[1, "m-steel"], [6, "m-brass"], [7, "m-glass"]],
      { "body3#1": "m-steel", "body1#1": "m-brass", "body1#2": "m-glass" }],
  ];
  for (const [label, keep, take, painted, moved] of cases) {
    for (const readFirst of [false, true]) {
      it(`moves each face's material to the piece its face went to: ${label}${readFirst ? ", the build read first" : ""}`, async () => {
        const { store, box } = opened();
        await store.rebuildNow();
        store.setFacesMaterial([{ body: "body2", face: 4 }], "m-glass");
        for (const [face, material] of painted) store.setFacesMaterial([{ body: "body1", face }], material);
        box.result = separated("base", keep, take);
        await store.rebuildNow();
        if (readFirst) entries(store);
        store.inheritBodyLook("body1", runs(keep, take));
        const want = { ...moved, "body2#4": "m-glass" };
        expect(entries(store)).toEqual(want);
        if (!painted.length) return;
        store.undo();
        expect(entries(store)).toEqual(Object.fromEntries(Object.entries(want).filter(([k]) => !k.startsWith("body3"))));
        store.redo();
        expect(entries(store)).toEqual(want);
      });
    }
  }

  it("leaves one whose face a rebuild took waiting on its body, and a second document gets none of it", async () => {
    const { store, box } = opened();
    await store.rebuildNow();
    store.setFacesMaterial([{ body: "body1", face: 3 }], "m-steel");
    store.setFacesMaterial([{ body: "body1", face: 7 }], "m-brass");
    box.result = reply("unstep");
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body1#4": "m-brass" });
    const hidden = store.hiddenFaceMaterials();
    expect(hidden).toEqual([expect.any(String)]);

    box.result = separated("unstep", [0, 1, 2], [3, 4, 5]);
    await store.rebuildNow();
    store.inheritBodyLook("body1", runs([0, 1, 2], [3, 4, 5]));
    expect(entries(store)).toEqual({ "body3#1": "m-brass" });
    expect(store.hiddenFaceMaterials()).toEqual(hidden);
    expect(JSON.parse(store.toJSON()).faceMaterials).toEqual({ "body1#3": "m-steel", "body3#1": "m-brass" });

    store.load(JSON.stringify({ ...DOC, faceMaterials: { "body2#2": "m-copper" } }));
    await store.rebuildNow();
    expect(entries(store)).toEqual({ "body2#2": "m-copper" });
    expect(store.hiddenFaceMaterials()).toEqual([]);
  });
});
