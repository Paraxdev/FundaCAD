// What the cursor is over during a "pick a plane" step.
//
// One arbitration is shared by Sketch, Offset Plane, Datum Plane, Midplane and
// Split, so that hovering and clicking can never disagree about what the click
// would take. There are four possible answers and the interesting part is the
// ORDER between them, which is why every case here is about two things being
// under the cursor at once.
//
// The bug this was written for: a datum plane was not one of the answers. A
// plane through three points appeared in the browser, drew its quad, highlighted
// on hover during ordinary selection and could be right-clicked, and could not
// be clicked to sketch on, because this function asked only about the three BASE
// planes and the ray went through the datum to whichever of those was behind it.
// Every construction the app can make was unreachable the one way people reach
// for a plane.

import { describe, expect, it } from "vitest";

import { CURVED_FACE_ROW, facePlaneOfRow, pickPlaneTarget } from "../../src/features/facePlanePick";
import { planeFromPointNormal } from "../../src/features/planeMath";
import type { Viewport } from "../../src/viewport/viewport";
import type { PlaneDef } from "../../src/types";
import { asVec, CYL_ANCHOR, CYL_NORMAL, FLAT_ANCHOR, faceRowViewport, SLANT_NORMAL } from "./faceRowRig";

const DATUM: PlaneDef = { origin: [0, -9, -3], normal: [0, -0.95, -0.31], xdir: [0, -0.31, 0.95] };

/** The three questions pickPlaneTarget asks, and nothing else.
 *
 *  A stub rather than a real Viewport: what is under test is the arbitration,
 *  and a real viewport would answer it with a WebGL context, a raycaster and a
 *  scene graph, none of which is the thing that was wrong. */
function stub(over: {
  face?: unknown;
  construction?: ReturnType<Viewport["pickConstructionAt"]>;
  onTop?: boolean;
}): Viewport {
  return {
    constructionOnTop: over.onTop ?? false,
    pickFaceForPressPull: () => over.face ?? null,
    pickConstructionAt: () => over.construction ?? null,
    // facePlaneFromHit's input. No triangles is the "this face implies no
    // plane" case, which is exactly what must NOT fall through to a quad.
    faceTriangles: () => [],
  } as unknown as Viewport;
}

describe("what a plane pick takes", () => {
  it("takes a datum plane when the cursor is over one", () => {
    const t = pickPlaneTarget(stub({ construction: { kind: "datum", id: "f7", def: DATUM } }), 0, 0);
    expect(t?.kind).toBe("datum");
    expect(t && t.kind === "datum" && t.spec).toEqual(DATUM);
    // The id travels with it. A sketch that knows which datum it is on follows
    // that datum when its offset is edited; one that only kept the resolved
    // plane is frozen where the plane happened to be at pick time.
    expect(t && t.kind === "datum" && t.id).toBe("f7");
  });

  it("takes a base plane when that is what the ray reached", () => {
    const t = pickPlaneTarget(stub({ construction: { kind: "base", plane: "XY" } }), 0, 0);
    expect(t).toEqual({ kind: "base", spec: "XY" });
  });

  it("takes nothing over empty space", () => {
    expect(pickPlaneTarget(stub({}), 0, 0)).toBeNull();
  });

  it("lets one raycast decide between a datum and a base plane", () => {
    // The control on the fix's shape. Two separate questions would have needed a
    // tie-break rule invented here, and the old code had one by accident, in
    // that it never asked the datum question at all. One raycast over both sets
    // means the depth buffer decides, so this function has no rule to get wrong:
    // whatever it is handed is what it returns.
    for (const c of [
      { kind: "datum", id: "f7", def: DATUM },
      { kind: "base", plane: "XZ" },
    ] as const) {
      const t = pickPlaneTarget(stub({ construction: c }), 0, 0);
      expect(t?.kind).toBe(c.kind);
    }
  });

  it("refuses a face that implies no plane rather than falling through to a quad", () => {
    // A blend, a sphere, a cone. The quads are switched on and sitting BEHIND
    // the model during this step, so "nothing usable here" must not become "take
    // the XY plane two hundred millimetres behind the face they were aiming at".
    const t = pickPlaneTarget(
      stub({
        face: { faceId: 3, anchor: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
        construction: { kind: "base", plane: "XY" },
      }),
      0,
      0,
    );
    expect(t).toEqual({ kind: "unusable" });
  });
  it("takes the plane drawn over a face while a tool asks for one", () => {
    const over = { face: { faceId: 1 }, construction: { kind: "base", plane: "XY" } as const };
    expect(pickPlaneTarget(stub({ ...over, onTop: true }), 0, 0)).toEqual({ kind: "base", spec: "XY" });
    expect(pickPlaneTarget(stub(over), 0, 0)?.kind).toBe("unusable");
  });
});

describe("what a Geometry list face row implies", () => {
  function rowStub(built = true) {
    const rig = faceRowViewport(built);
    return { vp: rig.parts as unknown as Viewport, asked: rig.asked };
  }

  it("a flat face gives its own plane and a selector that follows the face", () => {
    const { vp, asked } = rowStub();
    expect(facePlaneOfRow(vp, 14)).toEqual({
      def: planeFromPointNormal(asVec(FLAT_ANCHOR), asVec(SLANT_NORMAL)),
      kind: "planar",
      selector: { kind: "face", by: "nearest", point: asVec(FLAT_ANCHOR), body: "b2" },
      faceId: 14,
      at: asVec(FLAT_ANCHOR),
    });
    expect(asked).toEqual([[14]]);
  });

  it("a flat face on another body keeps that body in its selector", () => {
    const row = facePlaneOfRow(rowStub().vp, 23);
    expect(row?.kind).toBe("planar");
    expect(row?.selector).toMatchObject({ kind: "face", by: "nearest", body: "b3" });
  });

  it("a round face gives a tangent plane at its middle", () => {
    const row = facePlaneOfRow(rowStub().vp, 15);
    expect(row?.kind).toBe("tangent");
    expect(row?.faceId).toBe(15);
    expect(row?.at).toEqual(asVec(CYL_ANCHOR));
    const n = asVec(CYL_NORMAL);
    expect(row?.def.normal.map((c, i) => Math.abs(c - n[i]!)).every((d) => d < 1e-6)).toBe(true);
  });

  it("a face that is neither flat nor round gives nothing", () => {
    expect(facePlaneOfRow(rowStub().vp, 16)).toBeNull();
  });

  it("a face with no triangles, or no model, gives nothing", () => {
    expect(facePlaneOfRow(rowStub().vp, 99)).toBeNull();
    expect(facePlaneOfRow(rowStub(false).vp, 14)).toBeNull();
  });

  it("the curved hint names a flat face and a plane and does not send the user to the view", () => {
    expect(CURVED_FACE_ROW).toMatch(/curved/);
    expect(CURVED_FACE_ROW).toMatch(/flat face or a plane/);
    expect(CURVED_FACE_ROW).not.toMatch(/in the view/);
  });
});
