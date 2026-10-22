// The Picker under a section cut, with real body meshes and edge lines: a click, a hover and Measure go through
// pick() and pickEdgeCandidates(), so those must skip what the cut removes and reach what it keeps behind it.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { Picker } from "../../src/viewport/picking";
import { boxReply as reply, boxView, placed, STEP, STEP_CUT as halfCut, STEP_FRAME as M, stepCamera, stepPoint as local, STEP_FACES, type Lump } from "./boxBodies";

const W = 800, H = 600;
const RECT = { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect;

const camera = new THREE.PerspectiveCamera(45, W / H, 0.1, 5000);
camera.position.set(150, -170, 130);
camera.lookAt(40, 25, -10);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();
const sight = new THREE.Vector3(40, 25, -10).sub(camera.position).normalize();
const along = (t: number) => camera.position.clone().addScaledVector(sight, t);

// A small body in front of a big one on the line of sight, so every edge of the small one is drawn over the big one.
const PARTS: Lump[] = [
  { id: "near", body: "near", size: [24, 18, 30], m: placed(along(180), new THREE.Euler(0.4, -0.3, 0.7)) },
  { id: "far", body: "far", size: [80, 70, 90], m: placed(along(330), new THREE.Euler(-0.2, 0.5, 0.3)) },
];

const bodyOf = (faceId: number) => (faceId < 6 ? "near" : "far");
const screenOf = (p: THREE.Vector3) => {
  const s = p.clone().project(camera);
  return { x: (s.x * 0.5 + 0.5) * W, y: (-s.y * 0.5 + 0.5) * H };
};
// Between the two bodies, slanted to the line of sight, keeping the far side.
const cut = new THREE.Plane().setFromNormalAndCoplanarPoint(
  sight.clone().add(new THREE.Vector3(0.25, -0.15, 0.3)).normalize(),
  along(250),
);

describe("the Picker under a section cut", () => {
  it("a click on the removed body picks the kept body's face behind it", () => {
    const v = boxView(PARTS, W, H);
    const picker = new Picker();
    const hitBody = () => {
      const h = picker.pick(W / 2, H / 2, RECT, camera, v);
      return h?.kind === "face" ? bodyOf(h.faceId) : h?.kind ?? null;
    };
    expect(hitBody()).toBe("near");
    picker.setClip(cut);
    expect(hitBody()).toBe("far");
    picker.setClip(null);
    expect(hitBody()).toBe("near");
  });

  it("edges of the removed body are no candidates, and a pick on one lands on the kept body", () => {
    const v = boxView(PARTS, W, H);
    const picker = new Picker();
    const mid = (id: string) => {
      const e = reply(PARTS).edges.find((x) => x.id === id)!;
      return new THREE.Vector3(...e.points[0]!).add(new THREE.Vector3(...e.points[1]!)).multiplyScalar(0.5);
    };
    const ids = ["near-e0", "near-e5", "near-e9"];
    const at = ids.map((id) => screenOf(mid(id)));
    const cands = () => at.map((p) => picker.pickEdgeCandidates(p.x, p.y, RECT, camera, v).map((c) => c.edge.id));
    expect(cands().map((c) => c[0])).toEqual(ids);
    picker.setClip(cut);
    expect(cands()).toEqual([["far-e9"], [], []]);
    const picked = at.map((p) => {
      const h = picker.pick(p.x, p.y, RECT, camera, v);
      return h?.kind === "face" ? bodyOf(h.faceId) : h?.kind === "edge" ? h.edge.body : null;
    });
    expect(picked).toEqual(["far", "far", "far"]);
  });

  it("an edge of the kept body is seen through the removed body in front of it", () => {
    const v = boxView(PARTS, W, H);
    const picker = new Picker();
    const e = reply(PARTS).edges.find((x) => x.id === "far-e6")!;
    const at = screenOf(new THREE.Vector3(...e.points[0]!).add(new THREE.Vector3(...e.points[1]!)).multiplyScalar(0.5));
    const visible = () => picker.pickEdge(at.x, at.y, RECT, camera, v, { visibleOnly: true })?.edge.id ?? null;
    expect(visible()).toBe("near-e1");
    picker.setClip(cut);
    expect([visible(), picker.pickEdgeCandidates(at.x, at.y, RECT, camera, v).map((c) => c.edge.id)]).toEqual(["far-e6", ["far-e6"]]);
  });
});

const above = stepCamera(W, H);
const seen = (p: THREE.Vector3) => {
  const s = p.clone().project(above);
  return { x: (s.x * 0.5 + 0.5) * W, y: (-s.y * 0.5 + 0.5) * H };
};
const faceOf = (h: ReturnType<Picker["pick"]>) => (h?.kind === "face" ? h.faceId : h?.kind === "edge" ? h.edge.id : null);

describe("the Picker on a section's cap", () => {
  const cap = seen(local(-6, 4, 20));
  const floor = seen(local(38, -5, 10));
  // The tall block's bottom edge on its -y side, whose sight line crosses the cut inside the block.
  const bottom = reply(STEP).edges.find((e) =>
    e.points.every((p) => {
      const q = new THREE.Vector3(...p).applyMatrix4(M.clone().invert());
      return Math.abs(q.z) < 1e-3 && Math.abs(q.y + 15) < 1e-3 && Math.abs(q.x) < 21;
    }))!;
  const bottomAt = seen(local(0, -15, 0));

  it("a pick on the cap takes no face, past it the floor is still picked", () => {
    const v = boxView(STEP, W, H);
    const picker = new Picker();
    const picks = () => [cap, floor, bottomAt].map((p) => faceOf(picker.pick(p.x, p.y, RECT, above, v)));
    expect(picks()).toEqual([STEP_FACES.tallTop, STEP_FACES.lowTop, STEP_FACES.tallTop]);
    picker.setClip(halfCut);
    expect(picks()).toEqual([null, STEP_FACES.lowTop, null]);
  });

  it("an edge behind the cap is hidden by it, as the top face hid it before the cut", () => {
    const v = boxView(STEP, W, H);
    const picker = new Picker();
    const visible = () => picker.pickEdge(bottomAt.x, bottomAt.y, RECT, above, v, { visibleOnly: true })?.edge.id ?? null;
    expect([bottom.id, visible()]).toEqual(["tall-e10", null]);
    picker.setClip(halfCut);
    expect([picker.pickEdgeCandidates(bottomAt.x, bottomAt.y, RECT, above, v).map((c) => c.edge.id), visible()])
      .toEqual([[bottom.id], null]);
  });
});
