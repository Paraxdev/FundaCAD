// The Viewport's own body casts (bodyIdAt, faceIdAt, hoverFaceAt, Press/Pull, the drop target, the region tie's
// surface and the orbit pivot) under a cut: a ray that enters the kept half inside a body is on the cap, where the
// body is still there but no face is, and the surface is the cut plane.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Picker } from "../../src/viewport/picking";
import { Viewport } from "../../src/viewport/viewport";
import { boxView, STEP, STEP_CUT, STEP_FACES, STEP_FRAME, stepCamera, stepPoint } from "./boxBodies";

const W = 800, H = 600;
const camera = stepCamera(W, H);
const screen = (p: THREE.Vector3) => {
  const s = p.clone().project(camera);
  return { x: (s.x * 0.5 + 0.5) * W, y: (-s.y * 0.5 + 0.5) * H };
};
const CAP = screen(stepPoint(-6, 4, 20));
const FLOOR = screen(stepPoint(38, -5, 10));
const up = new THREE.Vector3(0, 0, 1).transformDirection(STEP_FRAME);

function bare(cut: boolean, selected: string[] = []) {
  const shown: unknown[] = [];
  const rc = new THREE.Raycaster();
  const vp = Object.create(Viewport.prototype) as Viewport;
  const picker = new Picker();
  picker.setClip(cut ? STEP_CUT : null);
  Object.assign(vp, {
    picker,
    canvas: { getBoundingClientRect: () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 }) },
    rig: { active: camera },
    selectPolicy: "auto",
    selectionMode: "bodies",
    intent: { dwelt: () => false },
    model: boxView(STEP, W, H),
    section: cut ? { ghost: 0.3 } : null,
    sectionPlane: STEP_CUT.clone(),
    surfaceRaycaster: Object.assign(new THREE.Raycaster(), { firstHitOnly: true }),
    streaming: false,
    dropKey: "",
    faceBands: new Map(),
    highlighter: {
      clearHover: () => shown.push("clear"),
      hoverFace: (f: number) => shown.push(f),
      hoverBody: (b: string | null) => shown.push(b),
      hoverFaceRun: (fs: readonly number[]) => shown.push([...fs]),
      getSelectedBodies: () => selected,
      getSelectedFaces: () => [],
      getSelectedEdges: () => [],
    },
    requestRender: () => {},
    rayFrom: (x: number, y: number) => {
      rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera);
      return rc;
    },
  });
  const ray = (p: { x: number; y: number }) => vp.rayFrom(p.x, p.y).ray.clone();
  return { vp, shown, ray };
}

describe("the Viewport's body casts on a section's cap", () => {
  it("the body is there, its faces are not, and past the cap the floor is", () => {
    const { vp } = bare(true);
    const at = (p: { x: number; y: number }) => [vp.bodyIdAt(p.x, p.y), vp.faceIdAt(p.x, p.y)];
    expect([at(CAP), at(FLOOR)]).toEqual([["step", null], ["step", STEP_FACES.lowTop]]);
    const before = bare(false).vp;
    expect([before.bodyIdAt(CAP.x, CAP.y), before.faceIdAt(CAP.x, CAP.y)]).toEqual(["step", STEP_FACES.tallTop]);
  });

  it("hover lights nothing on the cap and the floor past it", () => {
    const { vp, shown } = bare(true);
    expect([vp.hoverFaceAt(CAP.x, CAP.y), vp.hoverFaceAt(FLOOR.x, FLOOR.y)]).toEqual([null, STEP_FACES.lowTop]);
    expect(shown).toEqual(["clear", "clear", STEP_FACES.lowTop]);
  });

  it("Press/Pull grabs no face on the cap, and the floor with its own normal", () => {
    const { vp } = bare(true);
    expect(vp.pickFaceForPressPull(CAP.x, CAP.y)).toBeNull();
    const f = vp.pickFaceForPressPull(FLOOR.x, FLOOR.y)!;
    expect({ faceId: f.faceId, bodyId: f.bodyId, up: f.normal.dot(up), anchor: f.anchor.distanceTo(stepPoint(38, -5, 10)) })
      .toEqual({ faceId: STEP_FACES.lowTop, bodyId: "step", up: expect.closeTo(1, 6), anchor: expect.closeTo(0, 3) });
  });

  it("a drop on the cap has no target, past it the floor's face takes it", () => {
    const { vp, shown } = bare(true);
    expect([vp.dropTargetAt(CAP.x, CAP.y, "face"), vp.dropTargetAt(CAP.x, CAP.y, "body")]).toEqual([null, null]);
    expect(vp.dropTargetAt(FLOOR.x, FLOOR.y, "face"))
      .toEqual({ bodyId: "step", faceId: STEP_FACES.lowTop, localFace: STEP_FACES.lowTop });
    expect(shown).toEqual([null, [STEP_FACES.lowTop]]);
  });

  it("the surface on the cap is the cut plane, with no face, and the pivot sinks no deeper", () => {
    const { vp, ray } = bare(true);
    const toCut = ray(CAP).distanceToPlane(STEP_CUT)!;
    const pivot = (p: { x: number; y: number }) => {
      const r = ray(p);
      return vp["surfaceDistance"](r.origin, r.direction);
    };
    expect(vp.surfaceHitAt(CAP.x, CAP.y)).toEqual({ distance: expect.closeTo(toCut, 2), faceId: null });
    expect(pivot(CAP)).toBeCloseTo(toCut, 2);
    const floor = ray(FLOOR).origin.distanceTo(stepPoint(38, -5, 10));
    expect(vp.surfaceHitAt(FLOOR.x, FLOOR.y)).toEqual({ distance: expect.closeTo(floor, 3), faceId: STEP_FACES.lowTop });
    expect(pivot(FLOOR)).toBeCloseTo(floor, 3);
    const top = bare(false);
    expect(top.vp.surfaceHitAt(CAP.x, CAP.y)).toEqual({ distance: expect.closeTo(toCut - 16 / Math.abs(top.ray(CAP).direction.dot(up)), 3), faceId: STEP_FACES.tallTop });
  });
});

describe("a click on a section's cap under the auto policy", () => {
  it("takes the body, also when it is already selected, as there is no face to drill to", () => {
    expect([bare(true).vp.bodyClickAt(CAP.x, CAP.y), bare(true, ["step"]).vp.bodyClickAt(CAP.x, CAP.y)]).toEqual(["step", "step"]);
  });

  it("past the cap a selected body still drills to its face, and without the cut the top takes the body", () => {
    expect([bare(true, ["step"]).vp.bodyClickAt(FLOOR.x, FLOOR.y), bare(false).vp.bodyClickAt(CAP.x, CAP.y)]).toEqual([null, "step"]);
  });

  it("off the body takes nothing", () => {
    expect(bare(true).vp.bodyClickAt(5, 5)).toBeNull();
  });
});
