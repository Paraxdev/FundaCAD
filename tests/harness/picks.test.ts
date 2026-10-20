import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { edgePoint, faceInfo, facePoint, planePoint, resolveEdge, resolveFace, sketchPoint, worldPoint, type PickHost } from "../../src/harness/picks";
import { HarnessError } from "../../src/harness/locate";

type V = [number, number, number];

/** The six faces of an axis aligned box, two triangles each, outward wound. */
function boxFaces(min: V, max: V): THREE.Triangle[][] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const quad = (a: V, b: V, c: V, d: V) => [
    new THREE.Triangle(new THREE.Vector3(...a), new THREE.Vector3(...b), new THREE.Vector3(...c)),
    new THREE.Triangle(new THREE.Vector3(...a), new THREE.Vector3(...c), new THREE.Vector3(...d)),
  ];
  return [
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]), // +z
    quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]), // -z
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]), // -y
    quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]), // +y
    quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]), // -x
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]), // +x
  ];
}

const project = (w: THREE.Vector3) => ({ x: 100 + w.x * 10 + w.y * 3, y: 500 - w.z * 10 - w.y * 4 });

function rig(opts: { pick?: (x: number, y: number) => unknown } = {}) {
  const plate = boxFaces([0, 0, 0], [40, 20, 5]);
  const boss = boxFaces([50, 0, 0], [60, 10, 10]);
  const faces = [...plate, ...boss];
  const edges = [
    { id: "e-top-front", body: "body1", points: [[0, 0, 5], [40, 0, 5]] as V[] },
    { id: "e-top-right", body: "body1", points: [[40, 0, 5], [40, 20, 5]] as V[] },
    { id: "e-boss", body: "body2", points: [[50, 0, 10], [60, 0, 10]] as V[] },
  ];
  const state = { target: -1 as number, edge: "" };
  const planeXY = new THREE.Mesh(new THREE.PlaneGeometry(100, 100));
  const scene = new THREE.Scene();
  scene.add(planeXY);
  const datum = new THREE.Mesh(new THREE.PlaneGeometry(10, 10));
  datum.userData.datumId = "p1";
  datum.position.set(0, 0, 30);
  scene.add(datum);
  const h = {
    store: {
      buildState: {
        result: {
          bodies: [
            { id: "body1", name: "Plate", faceStart: 0, faceCount: 6 },
            { id: "body2", name: "Boss", faceStart: 6, faceCount: 6 },
          ],
          edges,
          bbox: { min: [0, 0, 0], max: [60, 20, 10] },
        },
      },
    },
    viewport: {
      faceTriangles: (fid: number) => faces[fid] ?? [],
      projectToScreen: project,
      pickEntity: (x: number, y: number) => opts.pick ? opts.pick(x, y) : state.edge
        ? { kind: "edge", edge: { id: state.edge } }
        : { kind: "face", faceId: state.target },
      pickEdgeAt: () => (state.edge ? { kind: "edge", edge: { id: state.edge } } : null),
      pickConstructionAt: () => ({ kind: "base", plane: "XY" }),
      scene: { scene, planes: { XY: planeXY, XZ: planeXY, YZ: planeXY } },
      domElement: {} as HTMLCanvasElement,
    },
    sketch: { active: false, activePlane: { to3D: (x: number, y: number) => new THREE.Vector3(x, y, 0) } },
  } as unknown as PickHost;
  return { h, state };
}

const all = () => true;

function err(fn: () => unknown): HarnessError {
  try { fn(); } catch (e) { if (e instanceof HarnessError) return e; throw e; }
  throw new Error("expected a harness error");
}

describe("face table", () => {
  it("reads normal, area, centroid and planarity from the triangles", () => {
    const [top] = boxFaces([0, 0, 0], [40, 20, 5]);
    const f = faceInfo(top!, "body1", 0, 0);
    expect(f.area).toBeCloseTo(800);
    expect(f.normal.toArray()).toEqual([0, 0, 1]);
    expect(f.centroid.toArray().map((v) => Math.round(v))).toEqual([20, 10, 5]);
    expect(f.planar).toBe(true);
  });

  it("calls a face curved when its triangles turn more than a degree", () => {
    const a = new THREE.Triangle(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 1, 0));
    const b = new THREE.Triangle(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 1, 0), new THREE.Vector3(0, 1, 0.2));
    expect(faceInfo([a, b], "b", 0, 0).planar).toBe(false);
  });
});

describe("face selectors", () => {
  const { h } = rig();

  it("names each side by its outward normal, Z up and front looking along +Y", () => {
    expect(resolveFace(h, "body1:top").index).toBe(0);
    expect(resolveFace(h, "body1:bottom").index).toBe(1);
    expect(resolveFace(h, "body1:front").index).toBe(2);
    expect(resolveFace(h, "body1:back").index).toBe(3);
    expect(resolveFace(h, "body1:left").index).toBe(4);
    expect(resolveFace(h, "body1:right").index).toBe(5);
    expect(resolveFace(h, "Plate:+x").index).toBe(5);
    expect(resolveFace(h, "body2:normal=0,0,2").faceId).toBe(6);
  });

  it("answers a side only with a flat face, never a bigger shallow dome", () => {
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    const r = 10 * Math.tan((1.5 * Math.PI) / 180);
    const roof = [
      new THREE.Triangle(v(-10, 0, 0), v(0, 0, r), v(0, 10, r)),
      new THREE.Triangle(v(-10, 0, 0), v(0, 10, r), v(-10, 10, 0)),
      new THREE.Triangle(v(0, 0, r), v(10, 0, 0), v(10, 10, 0)),
      new THREE.Triangle(v(0, 0, r), v(10, 10, 0), v(0, 10, r)),
    ];
    const flat = [new THREE.Triangle(v(20, 0, 0), v(21, 0, 0), v(21, 1, 0))];
    const faces = [roof, flat];
    const host = {
      store: { buildState: { result: { bodies: [{ id: "body1", name: "Dome", faceStart: 0, faceCount: 2 }], edges: [] } } },
      viewport: { faceTriangles: (fid: number) => faces[fid] ?? [] },
    } as unknown as PickHost;
    expect(faceInfo(roof, "body1", 0, 0).planar).toBe(false);
    expect(resolveFace(host, "top").index).toBe(1);
  });

  it("maps index= through the body's face range", () => {
    const f = resolveFace(h, "body2:index=3");
    expect(f.faceId).toBe(9);
    expect(err(() => resolveFace(h, "body2:index=6")).kind).toBe("NotFound");
  });

  it("says a face in range has nothing drawn instead of calling it out of range", () => {
    const [top] = boxFaces([0, 0, 0], [1, 1, 1]);
    const host = {
      store: { buildState: { result: { bodies: [{ id: "body1", name: "B", faceStart: 0, faceCount: 3 }], edges: [] } } },
      viewport: { faceTriangles: (fid: number) => (fid === 0 ? top! : []) },
    } as unknown as PickHost;
    const e = err(() => resolveFace(host, "index=1"));
    expect(e.message).toContain("face 1 of body1 has nothing drawn");
    expect(err(() => resolveFace(host, "index=3")).message).toContain("has faces 0 to 2, not 3");
  });

  it("finds the largest, the smallest and the nearest face", () => {
    expect(resolveFace(h, "body1:largest").index).toBe(0);
    expect(resolveFace(h, "body1:smallest planar").area).toBeCloseTo(100);
    expect(err(() => resolveFace(h, "body1:largest curved")).kind).toBe("NotFound");
    expect(resolveFace(h, "near=55,5,12").faceId).toBe(6);
  });

  it("needs a body when there are several, and lists the choices", () => {
    const e = err(() => resolveFace(h, "top"));
    expect(e.kind).toBe("Ambiguous");
    expect(e.candidates).toEqual(["body1:top", "body2:top"]);
    expect(err(() => resolveFace(h, "body9:top")).kind).toBe("NotFound");
    expect(err(() => resolveFace(h, "body1:sideways")).kind).toBe("BadArgs");
  });
});

describe("face points", () => {
  it("hands out a point the app's picker agrees is that face", () => {
    const { h, state } = rig();
    state.target = 0;
    const p = facePoint(h, "body1:top", all);
    expect(p).toMatchObject({ faceId: 0, body: "body1", index: 0 });
    expect(p.what).toContain("+z");
  });

  it("moves to the next sample when the picker sees another face there", () => {
    let calls = 0;
    const { h } = rig({ pick: () => ({ kind: "face", faceId: calls++ < 2 ? 3 : 0 }) });
    const p = facePoint(h, "body1:top", all);
    expect(calls).toBe(3);
    expect(p.faceId).toBe(0);
  });

  it("skips points under a panel, and says Occluded when none is left", () => {
    const { h, state } = rig();
    state.target = 0;
    let seen = 0;
    const p = facePoint(h, "body1:top", () => seen++ > 0);
    expect(seen).toBeGreaterThan(1);
    expect(p.faceId).toBe(0);
    const e = err(() => facePoint(h, "body1:bottom", all));
    expect(e.kind).toBe("Occluded");
    expect(e.message).toContain('s.view("bottom")');
  });
});

describe("edges", () => {
  it("finds an edge near a point, between two faces, and the longest", () => {
    const { h } = rig();
    expect(resolveEdge(h, "near=20,0,5").id).toBe("e-top-front");
    expect(resolveEdge(h, "body1:between top front").id).toBe("e-top-front");
    expect(resolveEdge(h, "body1:between top right").id).toBe("e-top-right");
    expect(resolveEdge(h, "body1:longest").id).toBe("e-top-front");
    expect(err(() => resolveEdge(h, "body1:between top bottom")).kind).toBe("NotFound");
  });

  it("finds an edge between faces whose meshes stop just short of each other", () => {
    const { h } = rig();
    const short = boxFaces([0, 0, 0], [40, 20, 4.9995])[2]!;
    const faces = h.viewport.faceTriangles;
    h.viewport.faceTriangles = (fid: number) => (fid === 2 ? short : faces(fid));
    expect(resolveEdge(h, "body1:between top front").id).toBe("e-top-front");
  });

  it("measures only the edges inside both faces' bounds for between", () => {
    const { h } = rig();
    const edges = h.store.buildState.result!.edges as { id: string; body: string; points: V[] }[];
    for (let i = 0; i < 200; i++) edges.push({ id: `far${i}`, body: "body1", points: [[0, 0, -50 - i], [40, 0, -50 - i]] });
    const spy = vi.spyOn(THREE.Triangle.prototype, "closestPointToPoint");
    expect(resolveEdge(h, "body1:between top front").id).toBe("e-top-front");
    expect(spy.mock.calls.length).toBeLessThan(100);
    spy.mockRestore();
  });

  it("verifies the point with the selection pick or the edge tools' pick", () => {
    const { h, state } = rig();
    state.edge = "e-top-right";
    expect(edgePoint(h, "body1:between top right", "select", all).edgeId).toBe("e-top-right");
    expect(edgePoint(h, "body1:between top right", "edge", all).edgeId).toBe("e-top-right");
    expect(err(() => edgePoint(h, "body1:between top front", "select", all)).kind).toBe("Occluded");
  });
});

describe("planes and free points", () => {
  it("verifies a base plane with the construction pick", () => {
    const { h } = rig();
    expect(planePoint(h, "xy", all).what).toBe("plane XY");
    expect(err(() => planePoint(h, "p1", all)).kind).toBe("Occluded");
    expect(err(() => planePoint(h, "p9", all)).kind).toBe("NotFound");
  });

  it("says how a hidden plane is shown", () => {
    const { h } = rig();
    h.viewport.scene.planes.XY.visible = false;
    const e = err(() => planePoint(h, "XY", all));
    expect(e.kind).toBe("Occluded");
    expect(e.message).toContain("a plane shows while a tool asks for one, or with Origin and planes in the Display panel");
  });

  it("says a sketch already open is why its planes are hidden", () => {
    const { h } = rig();
    h.viewport.scene.planes.XY.visible = false;
    (h.sketch as { active: boolean }).active = true;
    expect(err(() => planePoint(h, "XY", all)).message).toBe(
      "plane XY is hidden, a sketch is open and already on its plane, finish it to start one on another",
    );
  });

  it("projects world and sketch points and reports a covered one", () => {
    const { h } = rig();
    expect(worldPoint(h, 1, 0, 0, () => false)).toEqual({ x: 110, y: 500, covered: true });
    expect(err(() => sketchPoint(h, 1, 1, all)).kind).toBe("BadArgs");
    (h.sketch as { active: boolean }).active = true;
    expect(sketchPoint(h, 1, 0, all)).toEqual({ x: 110, y: 500, covered: false });
  });
});
