import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { createMethods, type HarnessHost } from "../../src/harness/driver";
import { overHandle } from "../../src/harness/handles";
import { resolveFace, type PickHost } from "../../src/harness/picks";

const W = 800,
  H = 600;

const tri = (a: number[], b: number[], c: number[]) =>
  new THREE.Triangle(new THREE.Vector3(...a), new THREE.Vector3(...b), new THREE.Vector3(...c));

/** One world unit is one pixel, looking down -Z. Each face is one square of two triangles. */
function rig(faces: THREE.Triangle[][]) {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0.1, 1000);
  camera.position.set(0, 0, 500);
  camera.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  const project = (w: THREE.Vector3) => {
    const v = w.clone().project(camera);
    return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
  };
  const h = {
    store: {
      buildState: {
        result: { bodies: [{ id: "body1", name: "Plate", faceStart: 0, faceCount: faces.length }], edges: [] },
      },
    },
    viewport: {
      scene: { scene },
      domElement: {} as HTMLCanvasElement,
      faceTriangles: (fid: number) => faces[fid] ?? [],
      projectToScreen: project,
      pickEntity: () => ({ kind: "face", faceId: 0 }),
      rayFrom: (x: number, y: number) => {
        rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera);
        return rc;
      },
    },
  } as unknown as HarnessHost & PickHost;
  return { h, scene };
}

const square = (x0: number, y0: number, x1: number, y1: number, z: number) => [
  tri([x0, y0, z], [x1, y0, z], [x1, y1, z]),
  tri([x0, y0, z], [x1, y1, z], [x0, y1, z]),
];

describe("face points", () => {
  it("never land on a handle drawn over the face", () => {
    const top = square(-100, -100, 100, 100, 5);
    const { h, scene } = rig([top]);
    const first = top[0]!.getMidpoint(new THREE.Vector3());
    const handle = new THREE.Mesh(new THREE.BoxGeometry(40, 40, 40));
    handle.position.copy(first);
    handle.userData.handle = "push";
    scene.add(handle);
    scene.updateMatrixWorld(true);
    const m = createMethods(h, {} as Document, {}, () => true);
    const p = m.facePoint!({ select: "top" }) as { x: number; y: number };
    expect(overHandle(h, p.x, p.y)).toBe(false);
  });
});

describe("faces facing one way", () => {
  it("take the one farthest out when two are the same size", () => {
    const { h } = rig([square(0, 0, 10, 10, 5), square(20, 0, 30, 10, 10)]);
    expect(resolveFace(h, "top").index).toBe(1);
  });
});
