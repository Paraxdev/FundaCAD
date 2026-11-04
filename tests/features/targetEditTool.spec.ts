// The History row that edits a feature's selection, as the user drives it: open it, click on the
// solid, Enter. The store and viewport are fakes that answer the way the rolled back build would.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { TargetEditTool } from "../../src/features/targetEditTool";
import { FEATURE_TARGETS, type TargetField } from "../../src/features/selectionTargets";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";
import { awaitTreePick, resetTreePicks, routeTreeClick, treePickWaiting, type TreePick } from "../../src/ui/treePick";
import { polylineMid } from "../../src/viewport/edgeMatch";
import type { EdgeRef } from "../../src/viewport/edgeLines";

const POINT: [number, number, number] = [1, 2, 3];
const SAVED: Selector = { kind: "face", by: "nearest", point: [0, 0, 15] };

function harness(feature: Feature, field: TargetField) {
  const canvas = document.createElement("canvas");
  const patches: Partial<Feature>[] = [];
  const painted: number[][] = [];
  const vp = {
    suspendPicking: false,
    selecting: "faces",
    domElement: canvas,
    emphasizeEdges: () => {},
    clearSelection: () => {},
    setSelectionMode: () => {},
    hoverEntity: () => {},
    selectEdgeLines: () => {},
    setSelectedBodies: () => {},
    selectFaces: (ids: number[]) => painted.push(ids),
    pickEntity: () => ({ kind: "face", faceId: 8, point: POINT }),
    // body1 owns faces 6 to 19, body2 starts at 20.
    faceIdToBodyId: (id: number): string | null => (id < 20 ? "body1" : "body2"),
    localFaceOf: (id: number): number | null => id - (id < 20 ? 6 : 20),
    edgeLineByMid: (): unknown => ({ slot: 11, body: "body2" }),
    // Faces 11 and 22 touch: body2's is only found by naming body2, and a gone body has no face.
    faceIdNear: (_p: unknown, _tol?: number, body?: string) => {
      if (body === "gone") return null;
      return body === "body2" ? 22 : 11;
    },
  };
  let build: (s: { building: boolean; result: object }) => void = () => {};
  const store = {
    document: { features: [feature] },
    buildState: {
      result: {
        bodies: [
          { id: "body1", name: "Bracket" },
          { id: "body2", name: "Lid" },
        ],
      },
    },
    bodyName: (): string | undefined => undefined,
    beginEditPreview: () => {},
    endEditPreview: () => {},
    updateFeature: (_id: string, p: Partial<Feature>) => patches.push(p),
    onBuild(fn: typeof build) {
      build = fn;
      return () => {};
    },
  };
  const tool = new TargetEditTool(vp as unknown as Viewport, store as unknown as DocumentStore);
  tool.start(feature.id, field);
  build({ building: false, result: {} });
  const click = () =>
    canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: 5, clientY: 5, button: 0, bubbles: true }));
  return { tool, vp, patches, painted, click };
}

const shellField = FEATURE_TARGETS.shell![0]!;
const shell = (faces: Selector | Selector[]) => ({ id: "s", type: "shell", faces, thickness: 1 }) as Feature;

describe("TargetEditTool", () => {
  beforeEach(() => setActivePinia(createPinia()));

  it("a face clicked for a shell is written with the body it belongs to", () => {
    const h = harness(shell([{ ...SAVED, body: "body2" }]), shellField);
    h.click();
    h.tool.commit();
    expect(h.patches).toEqual([
      {
        faces: [
          { ...SAVED, body: "body2" },
          { kind: "face", by: "nearest", point: POINT, body: "body1" },
        ],
      },
    ]);
  });

  it("a face clicked for a shell with no known owner stays unbound, the engine then takes the active body", () => {
    const h = harness(shell([SAVED]), shellField);
    h.vp.faceIdToBodyId = () => null;
    h.click();
    h.tool.commit();
    expect(h.patches).toEqual([{ faces: [SAVED, { kind: "face", by: "nearest", point: POINT }] }]);
  });

  it("an older saved shell with a bare selector and no body keeps that face unbound beside an added one", () => {
    const h = harness(shell(SAVED), shellField);
    expect(h.tool.rows()).toEqual([{ entry: SAVED, label: "Face 6 of Bracket", resolved: true }]);
    h.click();
    h.tool.commit();
    expect(h.patches).toEqual([{ faces: [SAVED, { kind: "face", by: "nearest", point: POINT, body: "body1" }] }]);
  });

  it("the row highlights a saved face on the body its selector names, not the nearest of any body", () => {
    const h = harness(shell([{ ...SAVED, body: "body2" }, SAVED]), shellField);
    expect(h.painted).toEqual([[22, 11]]);
  });

  it("a saved face on a body this build does not have stays listed, greyed", () => {
    const saved = { ...SAVED, body: "gone" };
    const h = harness(shell([saved]), shellField);
    expect(h.tool.rows()).toEqual([{ entry: saved, label: "Face not on this build", resolved: false }]);
  });

  it("a face clicked for a draft on a second body is written with that body", () => {
    const draft = { id: "d", type: "draft", faces: [{ ...SAVED, body: "body1" }], angle: 3 } as unknown as Feature;
    const h = harness(draft, FEATURE_TARGETS.draft![0]!);
    h.vp.faceIdToBodyId = () => "body2";
    h.click();
    h.tool.commit();
    expect(h.patches).toEqual([
      {
        faces: [
          { ...SAVED, body: "body1" },
          { kind: "face", by: "nearest", point: POINT, body: "body2" },
        ],
      },
    ]);
  });

  it("a face field that acts on one body writes no body on each face", () => {
    const offset = { id: "o", type: "offsetFace", faces: [SAVED], distance: 1, body: "body1" } as unknown as Feature;
    const h = harness(offset, FEATURE_TARGETS.offsetFace![0]!);
    h.click();
    h.tool.commit();
    expect(h.patches).toEqual([{ faces: [SAVED, { kind: "face", by: "nearest", point: POINT }] }]);
  });

  it("rows name a face by its number in its body, an edge by its slot, and tell the unresolved apart", () => {
    const faces = [{ ...SAVED, body: "body2" }, SAVED, { ...SAVED, body: "gone" }];
    expect(
      harness(shell(faces), shellField)
        .tool.rows()
        .map((r) => [r.label, r.resolved]),
    ).toEqual([
      ["Face 3 of Lid", true],
      ["Face 6 of Bracket", true],
      ["Face not on this build", false],
    ]);
    const fillet = {
      id: "f",
      type: "fillet",
      edges: [SAVED, { ...SAVED, body: "gone" }],
      radius: 1,
    } as unknown as Feature;
    const h = harness(fillet, FEATURE_TARGETS.fillet![0]!);
    expect(h.tool.rows().map((r) => [r.label, r.resolved])).toEqual([
      ["Edge 12 of Lid", true],
      ["Edge 12 of Lid", true],
    ]);
  });

  it("a face the viewport cannot place keeps its number off the row, a body row keeps its body label", () => {
    const h = harness(shell(SAVED), shellField);
    h.vp.localFaceOf = () => null;
    h.vp.faceIdToBodyId = () => null;
    expect(h.tool.rows().map((r) => r.label)).toEqual(["Face"]);
    const mirror = { id: "m", type: "mirror", targets: ["body2"] } as unknown as Feature;
    const bodies = harness(mirror, { field: "targets", label: "Bodies", kind: "body", shape: "bodyId", arity: "many" });
    expect(bodies.tool.rows().map((r) => r.label)).toEqual(["Lid"]);
  });
});

type P3 = [number, number, number];
const edgeOf = (a: P3, b: P3, body = "body1") => ({ points: [a, b], body }) as unknown as EdgeRef;
const E1 = edgeOf([10, 20, 5], [14, 23, 5]);
const E2 = edgeOf([-3, 8, 2], [-3, 8, 12], "body2");
const mid = (e: EdgeRef) => polylineMid(e.points)!;
const edgeSel = (e: EdgeRef) => ({ kind: "edge", by: "nearest", point: mid(e), body: (e as { body?: string }).body });

// The rolled back model shows `drawn`, the list rows come from a finished model that may differ.
function rowRig(feature: Feature, field: TargetField, drawn: EdgeRef[], bodies: string[], landed = true) {
  const patches: Partial<Feature>[] = [];
  const ended: boolean[] = [];
  const hints: string[] = [];
  const vp = {
    suspendPicking: false,
    selecting: "faces",
    domElement: document.createElement("canvas"),
    emphasizeEdges: () => {},
    clearSelection: () => {},
    setSelectionMode: () => {},
    hoverEntity: () => {},
    selectEdgeLines: () => {},
    selectFaces: () => {},
    setSelectedBodies: () => {},
    faceIdNear: () => 11,
    facesForPressPull: (ids: number[]) =>
      ids[0] === 3 ? { anchor: { x: 12.5, y: -7, z: 4 }, normal: { x: 0.6, y: 0, z: 0.8 }, bodyId: "body2" } : null,
    faceSelectorOf: (id: number) => ({ kind: "face", by: "nearest", point: [12.5 + id, -7, 4], body: "body2" }),
    edgeLineByMid: (p: P3) => drawn.find((e) => Math.hypot(...(mid(e).map((v, i) => v - p[i]!) as P3)) <= 0.5) ?? null,
  };
  let build: (s: { building: boolean; result: object }) => void = () => {};
  const store = {
    document: { features: [feature] },
    buildState: { result: { bodies: bodies.map((id) => ({ id })) } },
    bodyName: (id: string) => id,
    beginEditPreview: () => {},
    endEditPreview: (restore?: boolean) => ended.push(restore ?? true),
    updateFeature: (_id: string, p: Partial<Feature>) => patches.push(p),
    onBuild(fn: typeof build) {
      build = fn;
      return () => {};
    },
  };
  const tool = new TargetEditTool(vp as unknown as Viewport, store as unknown as DocumentStore);
  tool.start(feature.id, field);
  const land = () => build({ building: false, result: {} });
  if (landed) land();
  const row = (pick: TreePick) => routeTreeClick(pick, { busyHint: () => null, hint: (t) => hints.push(t) });
  const entries = () => tool.rows().map((r) => r.entry);
  return { tool, patches, ended, hints, land, row, entries };
}

const fillet = (edges: Selector[]) => ({ id: "f", type: "fillet", edges, radius: 1 }) as unknown as Feature;
const filletField = FEATURE_TARGETS.fillet![0]!;
const edgePick = (edge: EdgeRef): TreePick => ({ kind: "edge", edge });

describe("TargetEditTool rows", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    resetTreePicks();
  });

  it("an edge row is added with its body, a row of the same edge again takes it out, many edges stack", () => {
    const h = rowRig(fillet([]), filletField, [E1, E2], ["body1", "body2"]);
    expect(h.row(edgePick(E1))).toBe("taken");
    h.tool.commit();
    expect(h.patches).toEqual([{ edges: [edgeSel(E1)] }]);

    const g = rowRig(fillet([edgeSel(E1) as Selector]), filletField, [E1, E2], ["body1", "body2"]);
    expect(g.row(edgePick(E2))).toBe("taken");
    expect(g.entries()).toEqual([edgeSel(E1), edgeSel(E2)]);
    expect(g.row(edgePick(E1))).toBe("taken");
    expect(g.entries()).toEqual([edgeSel(E2)]);
    g.tool.commit();
    expect(g.patches).toEqual([{ edges: [edgeSel(E2)] }]);
  });

  it("a row of a kind the field does not take is refused and the set is unchanged", () => {
    const h = rowRig(fillet([]), filletField, [E1], ["body1"]);
    for (const pick of [
      { kind: "body", id: "body1" },
      { kind: "sketch", id: "sk" },
      { kind: "face", faceId: 4 },
    ] as TreePick[]) {
      expect(h.row(pick)).toBe("refused");
    }
    expect(h.hints).toHaveLength(3);
    expect(h.hints.every((t) => /edge/.test(t))).toBe(true);
    expect(h.entries()).toEqual([]);
  });

  it("an edge the rolled back model does not have is refused, to the exact tolerance", () => {
    const near = (dz: number) => edgeOf([10, 20, 5 + dz], [14, 23, 5 + dz]);
    const h = rowRig(fillet([]), filletField, [E1], ["body1"]);
    expect(h.row(edgePick(near(0.012)))).toBe("refused");
    expect(h.row(edgePick(edgeOf([40, 1, 1], [41, 2, 3])))).toBe("refused");
    expect(h.entries()).toEqual([]);
    expect(h.row(edgePick(near(0.009)))).toBe("taken");
    expect(h.entries()).toHaveLength(1);
  });

  it("a row before the roll back lands is refused, the next one after it is taken", () => {
    const h = rowRig(fillet([]), filletField, [E1], ["body1"], false);
    expect(h.row(edgePick(E1))).toBe("refused");
    expect(h.entries()).toEqual([]);
    h.land();
    expect(h.row(edgePick(E1))).toBe("taken");
    expect(h.entries()).toHaveLength(1);
  });

  it("a face row writes what a click writes, its body only where the field asks, a second row takes it out", () => {
    const h = rowRig(shell([{ ...SAVED, body: "body1" }]), shellField, [E1], ["body1", "body2"]);
    expect(h.row({ kind: "face", faceId: 3 })).toBe("taken");
    expect(h.row({ kind: "face", faceId: 5 })).toBe("taken");
    expect(h.entries()).toEqual([
      { ...SAVED, body: "body1" },
      { kind: "face", by: "nearest", point: [15.5, -7, 4], body: "body2" },
      { kind: "face", by: "nearest", point: [17.5, -7, 4], body: "body2" },
    ]);
    expect(h.row({ kind: "face", faceId: 3 })).toBe("taken");
    h.tool.commit();
    expect(h.patches).toEqual([
      {
        faces: [
          { ...SAVED, body: "body1" },
          { kind: "face", by: "nearest", point: [17.5, -7, 4], body: "body2" },
        ],
      },
    ]);

    const offset = { id: "o", type: "offsetFace", faces: [], distance: 2 } as unknown as Feature;
    const g = rowRig(offset, FEATURE_TARGETS.offsetFace![0]!, [E1], ["body2"]);
    expect(g.row({ kind: "face", faceId: 3 })).toBe("taken");
    expect(g.entries()).toEqual([{ kind: "face", by: "nearest", point: [15.5, -7, 4] }]);
  });

  it("a tracked face field takes the row's face with its normal, one face replaces the other", () => {
    const upTo = FEATURE_TARGETS.extrude!.find((f) => f.field === "upToFace")!;
    const h = rowRig({ id: "x", type: "extrude", upToFace: SAVED } as unknown as Feature, upTo, [E1], ["body2"]);
    expect(h.row({ kind: "face", faceId: 3 })).toBe("taken");
    expect(h.entries()).toEqual([
      { kind: "face", by: "tracked", point: [12.5, -7, 4], normal: [0.6, 0, 0.8], body: "body2" },
    ]);
    expect(h.row({ kind: "face", faceId: 9 })).toBe("refused");
    expect(h.hints).toEqual(["The model is still building"]);
    expect(h.entries()).toHaveLength(1);
  });

  it("a face field refuses an edge row as the wrong kind and keeps its faces", () => {
    const h = rowRig(shell([{ ...SAVED, body: "body1" }]), shellField, [E1], ["body1"]);
    expect(h.row(edgePick(E1))).toBe("refused");
    expect(h.hints).toHaveLength(1);
    expect(h.hints[0]).toMatch(/face/);
    expect(h.entries()).toEqual([{ ...SAVED, body: "body1" }]);
  });

  it("a one body field replaces its body, a many field adds and toggles, a folder adds what is missing", () => {
    const ground = { id: "m", type: "mechanism", ground: "body1" } as unknown as Feature;
    const one = rowRig(ground, FEATURE_TARGETS.mechanism![0]!, [], ["body1", "body2", "body3"]);
    expect(one.row({ kind: "body", id: "body2" })).toBe("taken");
    expect(one.entries()).toEqual(["body2"]);
    expect(one.row({ kind: "bodies", ids: ["body1", "body3"] })).toBe("refused");
    expect(one.entries()).toEqual(["body2"]);

    const many = { id: "r", type: "removeBody", bodies: ["body2"] } as unknown as Feature;
    const h = rowRig(many, FEATURE_TARGETS.removeBody![0]!, [], ["body1", "body2", "body3"]);
    expect(h.row({ kind: "body", id: "body3" })).toBe("taken");
    expect(h.entries()).toEqual(["body2", "body3"]);
    expect(h.row({ kind: "bodies", ids: ["body1", "body2", "body3"] })).toBe("taken");
    expect(h.entries()).toEqual(["body2", "body3", "body1"]);
    expect(h.row({ kind: "bodies", ids: ["body1", "body2", "body3"] })).toBe("taken");
    expect(h.entries()).toEqual([]);
    expect(h.row({ kind: "body", id: "body9" })).toBe("refused");
    expect(h.row({ kind: "bodies", ids: [] })).toBe("refused");
    expect(h.entries()).toEqual([]);
  });

  it("the rows go with the tool: none after a cancel, a second edit starts clean, another pick ends it", () => {
    const h = rowRig(fillet([edgeSel(E1) as Selector]), filletField, [E1, E2], ["body1", "body2"]);
    expect(treePickWaiting()).toBe(true);
    h.tool.cancel();
    expect(treePickWaiting()).toBe(false);
    expect(h.ended).toEqual([true]);

    const g = rowRig(fillet([]), filletField, [E1, E2], ["body1", "body2"]);
    expect(g.entries()).toEqual([]);
    expect(g.row(edgePick(E2))).toBe("taken");
    expect(g.entries()).toEqual([edgeSel(E2)]);
    expect(h.entries()).toEqual([]);

    awaitTreePick(
      () => true,
      () => {},
    );
    expect(g.tool.active).toBe(false);
    expect(g.ended).toEqual([true]);
  });
});
