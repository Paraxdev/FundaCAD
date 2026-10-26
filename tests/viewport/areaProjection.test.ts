// A box drag on a big mesh froze its first frames: the drag projected every vertex and copied every triangle before
// the box could draw. The face clusters are now built in idle time after the model lands, and a drag tests clusters,
// so these check that the first box finds the index built and walks only a sliver of the mesh, and that every box
// still takes exactly what the per triangle projection took (the fixture was written by that code).
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { areaWork, collectInBox, projectForArea } from "../../src/viewport/areaProjection";
import { areaIndexReady, areaIndexStats, scheduleAreaIndex } from "../../src/viewport/areaIndex";
import expected from "./fixtures/areaSelectExpected.json";
import { cameras, fakeBody, rects, smallModel, VIEW } from "./areaModel";
import type { ModelView } from "../../src/viewport/render";
import { allInsideRect, faceInBox, type AreaMode, type ScreenRect } from "../../src/viewport/areaSelect";

describe("box selection on a small model", () => {
  it("takes exactly what the per triangle projection took", () => {
    const got: Record<string, unknown> = {};
    for (const { name, cam } of cameras())
      for (const see of [false, true]) {
        const proj = projectForArea(smallModel(), cam, VIEW, see);
        for (const mode of ["window", "crossing"] as const)
          got[`${name}/${see ? "see" : "solid"}/${mode}`] = rects().map((r) => {
            const s = collectInBox(proj, r, mode);
            return { faces: s.faces, edges: s.edges.map((e) => e.id), bodies: s.bodies };
          });
      }
    expect(got).toEqual(expected);
  });
});

/** Every visible triangle projected and tested, the way the box worked before clusters. */
function bruteForce(model: ModelView, cam: THREE.Camera, see: boolean, r: ScreenRect, mode: AreaMode) {
  const vp = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
  const ortho = (cam as THREE.OrthographicCamera).isOrthographicCamera === true;
  const dir = cam.getWorldDirection(new THREE.Vector3());
  const faces: number[] = [];
  const bodies: string[] = [];
  for (const b of model.bodies) {
    const pos = b.mesh.geometry.getAttribute("position");
    const idx = b.mesh.geometry.getIndex()!;
    let touched = false;
    let allIn = true;
    let any = false;
    for (const [fid, tris] of b.faceTriangles) {
      const facing: number[][] = [];
      for (const t of tris) {
        const w = [0, 1, 2].map((k) =>
          new THREE.Vector3().fromBufferAttribute(pos, idx.getX(t * 3 + k)).applyMatrix4(b.mesh.matrixWorld),
        );
        const n = w[1]!.clone().sub(w[0]!).cross(w[2]!.clone().sub(w[0]!));
        if (!see && n.dot(ortho ? dir : w[0]!.clone().sub(cam.position)) >= 0) continue;
        facing.push(
          w.flatMap((p) => {
            const q = new THREE.Vector4(p.x, p.y, p.z, 1).applyMatrix4(vp);
            if (!(q.w > 0)) return [NaN, NaN];
            return [
              VIEW.left + ((q.x / q.w) * 0.5 + 0.5) * VIEW.width,
              VIEW.top + ((-q.y / q.w) * 0.5 + 0.5) * VIEW.height,
            ];
          }),
        );
      }
      const hit = faceInBox(facing, r, mode);
      if (facing.length) any = true;
      if (facing.some((t) => !allInsideRect(t, r))) allIn = false;
      if (hit) {
        faces.push(fid);
        touched = true;
      }
    }
    if (mode === "window" ? any && allIn : touched) bodies.push(b.id);
  }
  return { faces, bodies };
}

describe("box selection on a curved mesh of many faces", () => {
  // Bumpy, so clusters bend; one body mirrored, so its transform turns every normal round.
  const bumpy = (mirror: boolean) => {
    const g = new THREE.TorusKnotGeometry(14, 4, 120, 16);
    const p = g.getAttribute("position");
    for (let i = 0; i < p.count; i++) p.setZ(i, p.getZ(i) + Math.sin(p.getX(i) * 0.7) * 1.5);
    const body = fakeBody(
      mirror ? "knotM" : "knot",
      g,
      (t) => Math.floor(t / 300),
      new THREE.Vector3(mirror ? 25 : -20, 0, 5),
    );
    if (mirror) {
      body.mesh.scale.set(-1, 1.3, 0.8);
      body.mesh.rotation.set(0.4, 0.2, 1.1);
      body.mesh.updateMatrixWorld(true);
    }
    return body;
  };
  it("takes what testing every triangle takes", () => {
    const model = { bodies: [bumpy(false), bumpy(true)], edges: [] } as unknown as ModelView;
    for (const { cam } of cameras())
      for (const see of [false, true]) {
        const proj = projectForArea(model, cam, VIEW, see);
        for (const mode of ["window", "crossing"] as const)
          for (const r of rects()) {
            const got = collectInBox(proj, r, mode);
            expect({ faces: got.faces, bodies: got.bodies }).toEqual(bruteForce(model, cam, see, r, mode));
          }
      }
  });
});

async function idle(done: () => boolean) {
  for (let i = 0; i < 2000 && !done(); i++) await new Promise((r) => setTimeout(r, 1));
}

describe("the first box on a big mesh", () => {
  // About 200k triangles in one face, the shape of an imported STL.
  const torus = new THREE.TorusGeometry(60, 20, 400, 250);
  const body = fakeBody("mesh", torus, () => 0, new THREE.Vector3(40, -25, 30));
  const tris = torus.index!.count / 3;
  const model = { bodies: [body], edges: [], orphanEdges: null, box: new THREE.Box3() } as unknown as ModelView;
  const cam = cameras()[0]!.cam;
  cam.position.set(0, -260, 160);
  cam.lookAt(40, -25, 30);
  cam.updateMatrixWorld();
  // The front of the tube, nearest the camera.
  const front = new THREE.Vector3(40, -105, 30).project(cam);
  const fx = VIEW.left + (front.x * 0.5 + 0.5) * VIEW.width;
  const fy = VIEW.top + (-front.y * 0.5 + 0.5) * VIEW.height;
  const onMesh = { x0: fx - 3, y0: fy - 3, x1: fx + 3, y1: fy + 3 };

  it("finds its index built in idle time, before the drag", async () => {
    scheduleAreaIndex(body);
    expect(areaIndexReady(body)).toBe(false);
    await idle(() => areaIndexReady(body));
    expect(areaIndexReady(body)).toBe(true);
    const sync = areaIndexStats.syncBuilds;
    const proj = projectForArea(model, cam, VIEW, false);
    collectInBox(proj, onMesh, "crossing");
    expect(areaIndexStats.syncBuilds).toBe(sync);
  });

  it("walks a sliver of the triangles when the box opens", () => {
    areaWork.triangles = 0;
    areaWork.vertices = 0;
    const proj = projectForArea(model, cam, VIEW, false);
    for (const r of [onMesh, { x0: 50, y0: 50, x1: 56, y1: 55 }])
      for (const mode of ["window", "crossing"] as const) collectInBox(proj, r, mode);
    expect(areaWork.triangles).toBeLessThan(tris / 50);
    expect(areaWork.vertices).toBeLessThan(tris / 10);
  });

  it("still takes the mesh when the box crosses it, and only then", () => {
    const proj = projectForArea(model, cam, VIEW, false);
    const on = collectInBox(proj, onMesh, "crossing");
    const off = collectInBox(proj, { x0: 15, y0: 25, x1: 20, y1: 30 }, "crossing");
    const all = collectInBox(proj, { x0: 10, y0: 20, x1: 910, y1: 620 }, "window");
    expect(on.bodies).toEqual(["mesh"]);
    expect(off.bodies).toEqual([]);
    expect(all.bodies).toEqual(["mesh"]);
  });
});
