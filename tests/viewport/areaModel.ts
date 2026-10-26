// Small models and cameras for box selection tests, built from three geometries with faces assigned by hand.
import * as THREE from "three";
import type { BodyMesh, ModelView } from "../../src/viewport/render";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { ScreenRect } from "../../src/viewport/areaSelect";

let nextFace = 0;

/** `faceOf` names a triangle's face, local to the body; faces are numbered globally from there. */
export function fakeBody(id: string, geo: THREE.BufferGeometry, faceOf: (t: number) => number, at?: THREE.Vector3) {
  const g = geo.index
    ? geo
    : (() => {
        const pos = geo.getAttribute("position");
        geo.setIndex([...Array(pos.count).keys()]);
        return geo;
      })();
  const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial());
  if (at) mesh.position.copy(at);
  mesh.updateMatrixWorld(true);
  const faceTriangles = new Map<number, number[]>();
  const base = nextFace;
  let top = 0;
  for (let t = 0; t < g.index!.count / 3; t++) {
    const f = base + faceOf(t);
    top = Math.max(top, faceOf(t) + 1);
    let list = faceTriangles.get(f);
    if (!list) faceTriangles.set(f, (list = []));
    list.push(t);
  }
  nextFace += top;
  return { id, name: id, mesh, faceTriangles, faceStart: base, faceCount: top } as unknown as BodyMesh;
}

export function fakeEdge(id: string, points: [number, number, number][]): EdgeRef {
  return {
    id,
    body: undefined,
    points,
    smooth: false,
    draw: { object: { visible: true } },
    slot: 0,
  } as unknown as EdgeRef;
}

/** A box, a moved cylinder, a two face sphere and a ground plane that runs behind the camera. */
export function smallModel(): ModelView {
  nextFace = 0;
  const box = new THREE.BoxGeometry(20, 20, 20);
  const cyl = new THREE.CylinderGeometry(8, 8, 30, 24, 3);
  const cylSide = 24 * 3 * 2;
  const sphere = new THREE.SphereGeometry(10, 24, 16);
  const plane = new THREE.PlaneGeometry(400, 400, 8, 8);
  const bodies = [
    fakeBody("box", box, (t) => t >> 2),
    fakeBody("cyl", cyl, (t) => (t < cylSide ? 0 : t < cylSide + 24 ? 1 : 2), new THREE.Vector3(30, 5, 0)),
    fakeBody("sphere", sphere, (t) => t % 2, new THREE.Vector3(-25, 20, 10)),
    fakeBody("plane", plane, () => 0, new THREE.Vector3(0, 0, -12)),
  ];
  const edges = [
    fakeEdge("e1", [
      [-10, -10, 10],
      [10, -10, 10],
    ]),
    fakeEdge("e2", [
      [30, 5, 15],
      [38, 5, 15],
      [38, 13, 15],
    ]),
  ];
  return { bodies, edges, orphanEdges: null, box: new THREE.Box3() } as ModelView;
}

export function cameras(): { name: string; cam: THREE.Camera }[] {
  const persp = new THREE.PerspectiveCamera(45, 1.5, 0.1, 2000);
  persp.up.set(0, 0, 1);
  persp.position.set(60, -80, 50);
  persp.lookAt(0, 0, 0);
  persp.updateMatrixWorld();
  const ortho = new THREE.OrthographicCamera(-60, 60, 40, -40, 0.1, 2000);
  ortho.up.set(0, 0, 1);
  ortho.position.set(-70, -90, 60);
  ortho.lookAt(0, 0, 0);
  ortho.updateMatrixWorld();
  return [
    { name: "persp", cam: persp },
    { name: "ortho", cam: ortho },
  ];
}

export const VIEW = { left: 10, top: 20, width: 900, height: 600, right: 910, bottom: 620, x: 10, y: 20 } as DOMRect;

/** Whole view, quarters, strips, and small boxes on a grid. */
export function rects(): ScreenRect[] {
  const out: ScreenRect[] = [{ x0: 10, y0: 20, x1: 910, y1: 620 }];
  for (const [x, y] of [
    [10, 20],
    [460, 20],
    [10, 320],
    [460, 320],
  ])
    out.push({ x0: x!, y0: y!, x1: x! + 450, y1: y! + 300 });
  out.push({ x0: 300, y0: 20, x1: 340, y1: 620 }, { x0: 10, y0: 300, x1: 910, y1: 330 });
  for (let x = 60; x < 900; x += 140)
    for (let y = 60; y < 600; y += 110) {
      out.push({ x0: x, y0: y, x1: x + 30, y1: y + 25 });
      out.push({ x0: x - 50, y0: y - 40, x1: x + 160, y1: y + 120 });
    }
  return out;
}
