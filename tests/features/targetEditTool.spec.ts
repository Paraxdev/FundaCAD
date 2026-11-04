// The History row that edits a feature's selection, as the user drives it: open it, click on the
// solid, Enter. The store and viewport are fakes that answer the way the rolled back build would.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { TargetEditTool } from "../../src/features/targetEditTool";
import { FEATURE_TARGETS, type TargetField } from "../../src/features/selectionTargets";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Feature, Selector } from "../../src/types";

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
