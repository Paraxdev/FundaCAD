import { describe, expect, it } from "vitest";
import { createDatumPlanes } from "../../src/app/datumPlanes";
import type { Engine } from "../../src/app/engine";
import type { Feature, PlaneDef } from "../../src/types";
import { placeDatum, ZERO_POSE } from "../../src/document/datumPose";

type Datum = Extract<Feature, { type: "datumPlane" }>;

function engine(features: Feature[], placed: Record<string, PlaneDef> = {}) {
  const drawn: { id: string; origin: number[] }[][] = [];
  const e = {
    store: {
      document: { features },
      buildState: { result: { datumPlanes: placed } },
      rollbackIndex: features.length,
      isSuppressed: () => false,
      isPlaneVisible: () => true,
    },
    viewport: {
      setDatumPlanes: (p: { id: string; origin: number[] }[]) => drawn.push(p),
      setDatumMarkers: () => {},
      highlightDatum: () => {},
      requestRender: () => {},
    },
    selectedFeature: null,
  } as unknown as Engine;
  return { e, api: createDatumPlanes(e), drawn };
}

const p0 = { id: "P0", type: "datumPlane", plane: "XY", offset: 10 } as Datum;
const p1 = { id: "P1", type: "datumPlane", plane: "XY", planeId: "P0", offset: 10, tiltX: 90 } as Datum;

describe("datum planes as the app draws them", () => {
  it("places a child on its parent datum, pose and all", () => {
    const { api } = engine([p0, p1]);
    const d = api.datumPlaneDef(p1);
    expect(d.origin).toEqual([0, 0, 20]);
    expect(d.normal).toEqual([0, -1, 0]);
  });

  it("moves the child the moment the parent moves, before any rebuild", () => {
    const { api } = engine([{ ...p0, offset: 25 }, p1]);
    expect(api.datumPlaneDef(p1).origin).toEqual([0, 0, 35]);
  });

  it("draws a dragged pose, and the children with it, then lets it go", () => {
    const { api, drawn } = engine([p0, p1]);
    api.previewDatumPose("P0", { ...ZERO_POSE, offset: 30 });
    expect(drawn.at(-1)!.find((q) => q.id === "P1")!.origin).toEqual([0, 0, 40]);
    api.previewDatumPose("P0", null);
    expect(drawn.at(-1)!.find((q) => q.id === "P1")!.origin).toEqual([0, 0, 20]);
  });

  it("ignores a parent below it in the timeline, as the engine does", () => {
    const { api } = engine([p1, p0]);
    expect(api.datumPlaneDef(p1).origin).toEqual([0, 0, 10]);
  });

  it("backs a face datum's pose out of where the engine put it", () => {
    const face: PlaneDef = { origin: [0, 0, 7], normal: [0, 0, 1], xdir: [1, 0, 0] };
    const f = {
      id: "F", type: "datumPlane", plane: { origin: [0, 0, 5], normal: [0, 0, 1], xdir: [1, 0, 0] },
      face: { kind: "face", by: "nearest", point: [0, 0, 5] }, offset: 3, tiltY: 30,
    } as unknown as Datum;
    const pose = { ...ZERO_POSE, offset: 3, tiltY: 30 };
    const { api } = engine([f], { F: placeDatum(face, pose) });
    const src = api.datumSourceOf(f) as PlaneDef;
    src.origin.forEach((v, i) => expect(v).toBeCloseTo(face.origin[i]!, 9));
    src.normal.forEach((v, i) => expect(v).toBeCloseTo(face.normal[i]!, 9));
  });
});
