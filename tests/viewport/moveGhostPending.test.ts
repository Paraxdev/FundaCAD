// A body dragged with the move gizmo while an earlier move of it is still
// rebuilding: the old mesh still wears that move as its pose, so every preview
// frame must draw the drag on top of it, exactly where the commit will land.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { GhostLayer } from "../../src/viewport/ghosts";
import type { BodyEdges, BodyMesh, ModelView } from "../../src/viewport/render";

const deg = Math.PI / 180;
const about = (c: THREE.Vector3, r: THREE.Matrix4) =>
  new THREE.Matrix4().makeTranslation(c.x, c.y, c.z).multiply(r).multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
const euler = (x: number, y: number, z: number) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x * deg, y * deg, z * deg));
const shift = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);

const PIVOT = new THREE.Vector3(23, 150, 140);
const QUARTER_X = about(PIVOT, euler(90, 0, 0));
const SLANTED = shift(40, -15, 7).multiply(about(PIVOT, euler(37, -20, 11)));
const SECOND = about(new THREE.Vector3(-31, 64, 18), euler(0, 0, -52));

type Id = "shroud" | "fan" | "rail";
const VERTS: Record<Id, THREE.Vector3[]> = {
  shroud: [new THREE.Vector3(10, 200, 50), new THREE.Vector3(37, -81, 13), new THREE.Vector3(-64, 122, -9)],
  fan: [new THREE.Vector3(-12, 33, 71), new THREE.Vector3(58, 140, -26)],
  rail: [new THREE.Vector3(211, -47, 5), new THREE.Vector3(-150, 9, 88), new THREE.Vector3(3, 17, -40), new THREE.Vector3(76, -2, 61)],
};

/** Local vertices kept in doubles, a baked body holds its pending move in them as a rebuilt one does. */
const local = new WeakMap<THREE.Object3D, THREE.Vector3[]>();
function makeBody(id: Id, bake = new THREE.Matrix4(), parent?: THREE.Object3D): BodyMesh {
  const vs = VERTS[id].map((v) => v.clone().applyMatrix4(bake));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(vs.flatMap((v) => v.toArray()), 3));
  const mesh = new THREE.Mesh(geo);
  const edges = { object: new THREE.Object3D() } as unknown as BodyEdges;
  local.set(mesh, vs);
  local.set(edges.object, vs);
  parent?.add(mesh, edges.object);
  return { id, name: id, mesh, edges } as unknown as BodyMesh;
}

function scene(parent?: THREE.Object3D) {
  const view = (bodies: BodyMesh[]): ModelView => ({ bodies, edges: [], orphanEdges: null, box: new THREE.Box3() });
  let model = view((Object.keys(VERTS) as Id[]).map((id) => makeBody(id, undefined, parent)));
  const ghosts = new GhostLayer({
    model: () => model, addToScene: () => {}, removeFromScene: () => {},
    requestRender: () => {}, faceNormalWorld: () => new THREE.Vector3(0, 0, 1),
  });
  const body = (id: Id) => model.bodies.find((b) => b.id === id)!;
  const show = (bodies: BodyMesh[]) => { model = view(bodies); };
  return { ghosts, body, show };
}

const round = (v: THREE.Vector3) => v.toArray().map((n) => Math.round(n * 1e4) / 1e4 + 0);
function drawn(obj: THREE.Object3D) {
  obj.updateWorldMatrix(true, false);
  return local.get(obj)!.map((v) => round(v.clone().applyMatrix4(obj.matrixWorld)));
}
const expected = (id: Id, world: THREE.Matrix4) => VERTS[id].map((v) => round(v.clone().applyMatrix4(world)));

/** Commits each move in turn with its rebuild never landing, as a big import does. */
function pend(ghosts: GhostLayer, ids: Id[], moves: THREE.Matrix4[]) {
  for (const m of moves) {
    ghosts.beginBodyMoveGhost(ids);
    ghosts.setBodyMoveTransform(m);
    ghosts.endBodyMoveGhost(false);
  }
}

function centroid(ids: Id[], pose: Record<Id, THREE.Matrix4>) {
  const c = new THREE.Vector3();
  let n = 0;
  for (const id of ids) for (const v of VERTS[id]) { c.add(v.clone().applyMatrix4(pose[id])); n++; }
  return c.divideScalar(n);
}

/** Every frame of an arrow drag along X, Y and Z, then a ring drag about each axis through the selection's centre. */
function dragFrames(centre: THREE.Vector3): THREE.Matrix4[] {
  const steps = [0, -18, -74, -130, 40];
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const frames: THREE.Matrix4[] = [];
  for (const a of axes) for (const s of steps) frames.push(shift(a.x * s, a.y * s, a.z * s));
  for (const a of axes) for (const t of [7, 23, -11]) frames.push(about(centre, new THREE.Matrix4().makeRotationAxis(a, t * deg)));
  return frames;
}

describe("move ghost over a move whose rebuild has not landed", () => {
  const cases: [string, Partial<Record<Id, THREE.Matrix4[]>>][] = [
    ["no pending move", {}],
    ["a quarter turn about X pending", { shroud: [QUARTER_X] }],
    ["a slanted turn and shift pending", { shroud: [SLANTED] }],
    ["two moves pending", { shroud: [SLANTED, SECOND] }],
  ];
  for (const [label, pending] of cases) {
    it(`previews every drag frame where the commit lands, ${label}`, () => {
      const { ghosts, body } = scene();
      for (const [id, moves] of Object.entries(pending) as [Id, THREE.Matrix4[]][]) pend(ghosts, [id], moves);
      const before = (id: Id) => (pending[id] ?? []).reduce((acc, m) => m.clone().multiply(acc), new THREE.Matrix4());
      const pose = { shroud: before("shroud"), fan: before("fan"), rail: before("rail") };
      const frames = dragFrames(centroid(["shroud"], pose));
      ghosts.beginBodyMoveGhost(["shroud"]);
      const seen = frames.map((m) => {
        ghosts.setBodyMoveTransform(m);
        return [drawn(body("shroud").mesh), drawn(body("shroud").edges.object), drawn(body("fan").mesh)];
      });
      const want = frames.map((m) => {
        const w = m.clone().multiply(pose.shroud);
        return [expected("shroud", w), expected("shroud", w), expected("fan", pose.fan)];
      });
      expect(seen).toEqual(want);
    });
  }

  it("moves several bodies with different pending moves together, each from its own pose", () => {
    const { ghosts, body } = scene();
    pend(ghosts, ["shroud"], [QUARTER_X]);
    pend(ghosts, ["fan"], [SLANTED, SECOND]);
    const pose: Record<Id, THREE.Matrix4> = { shroud: QUARTER_X, fan: SECOND.clone().multiply(SLANTED), rail: new THREE.Matrix4() };
    const ids: Id[] = ["shroud", "fan", "rail"];
    const frames = dragFrames(centroid(ids, pose));
    ghosts.beginBodyMoveGhost(ids);
    const seen = frames.map((m) => {
      ghosts.setBodyMoveTransform(m);
      return ids.flatMap((id) => [drawn(body(id).mesh), drawn(body(id).edges.object)]);
    });
    const want = frames.map((m) => ids.flatMap((id) => {
      const w = m.clone().multiply(pose[id]);
      return [expected(id, w), expected(id, w)];
    }));
    expect(seen).toEqual(want);
  });

  it("puts a cancelled drag back on the pending pose and keeps a committed one on top of it", () => {
    const { ghosts, body } = scene();
    pend(ghosts, ["shroud"], [SLANTED]);
    const drag = shift(0, -120, 0).multiply(about(PIVOT, euler(0, 0, 23)));
    const look = () => [drawn(body("shroud").mesh), drawn(body("shroud").edges.object)];

    ghosts.beginBodyMoveGhost(["shroud"]);
    ghosts.setBodyMoveTransform(drag);
    ghosts.endBodyMoveGhost(true);
    const cancelled = look();

    ghosts.beginBodyMoveGhost(["shroud"]);
    ghosts.setBodyMoveTransform(drag);
    ghosts.endBodyMoveGhost(false);
    const committed = look();

    ghosts.beginBodyMoveGhost(["shroud"]);
    ghosts.endBodyMoveGhost(true);
    const reopened = look();

    const after = drag.clone().multiply(SLANTED);
    expect({ cancelled, committed, reopened }).toEqual({
      cancelled: [expected("shroud", SLANTED), expected("shroud", SLANTED)],
      committed: [expected("shroud", after), expected("shroud", after)],
      reopened: [expected("shroud", after), expected("shroud", after)],
    });
  });

  it("applies the drag in world space when the meshes sit under a turned parent", () => {
    const parent = new THREE.Group();
    parent.applyMatrix4(shift(-35, 12, 60).multiply(euler(-90, 0, 28)));
    const { ghosts, body } = scene(parent);
    pend(ghosts, ["shroud"], [SLANTED]);
    parent.updateMatrixWorld(true);
    const pose = SLANTED.clone().multiply(parent.matrixWorld);
    const frames = dragFrames(PIVOT);
    ghosts.beginBodyMoveGhost(["shroud"]);
    const seen = frames.map((m) => {
      ghosts.setBodyMoveTransform(m);
      return [drawn(body("shroud").mesh), drawn(body("shroud").edges.object)];
    });
    ghosts.endBodyMoveGhost(true);
    const cancelled = drawn(body("shroud").mesh);
    const want = frames.map((m) => {
      const w = m.clone().multiply(pose);
      return [expected("shroud", w), expected("shroud", w)];
    });
    expect({ seen, cancelled }).toEqual({ seen: want, cancelled: expected("shroud", pose) });
  });

  it("follows a rebuilt mesh that lands mid-drag and keeps moving one the stream still holds", () => {
    const { ghosts, body, show } = scene();
    pend(ghosts, ["shroud"], [SLANTED]);
    pend(ghosts, ["fan"], [QUARTER_X]);
    const ids: Id[] = ["shroud", "fan", "rail"];
    const pose: Record<Id, THREE.Matrix4> = { shroud: SLANTED, fan: QUARTER_X, rail: new THREE.Matrix4() };
    const old = { shroud: body("shroud"), fan: body("fan"), rail: body("rail") };
    const rebuilt = { shroud: makeBody("shroud", SLANTED), fan: makeBody("fan", QUARTER_X) };
    // old model, then the stream holds the moved bodies off its view, then they land one by one
    const stages = [null, [old.rail], [rebuilt.shroud, old.rail], [rebuilt.shroud, rebuilt.fan, old.rail]];
    const frames = dragFrames(centroid(ids, pose));
    const onScreen: Record<Id, BodyMesh> = { ...old };
    ghosts.beginBodyMoveGhost(ids);
    const seen = frames.map((m, i) => {
      const bodies = stages[Math.floor((i * stages.length) / frames.length)];
      if (bodies) {
        show(bodies);
        for (const b of bodies) onScreen[b.id as Id] = b;
      }
      ghosts.setBodyMoveTransform(m);
      return ids.flatMap((id) => [drawn(onScreen[id].mesh), drawn(onScreen[id].edges.object)]);
    });
    ghosts.endBodyMoveGhost(true);
    const cancelled = ids.map((id) => drawn(onScreen[id].mesh));
    const want = frames.map((m) => ids.flatMap((id) => {
      const w = m.clone().multiply(pose[id]);
      return [expected(id, w), expected(id, w)];
    }));
    expect({ seen, cancelled }).toEqual({ seen: want, cancelled: ids.map((id) => expected(id, pose[id])) });
  });

  it("poses a rebuilt mesh that lands between the last frame and the release at the drag", () => {
    const { ghosts, body, show } = scene();
    pend(ghosts, ["shroud"], [SLANTED]);
    const rebuilt = makeBody("shroud", SLANTED);
    const drag = shift(-26, 0, 9).multiply(about(PIVOT, euler(0, 14, 0)));
    ghosts.beginBodyMoveGhost(["shroud"]);
    ghosts.setBodyMoveTransform(drag);
    show([rebuilt, body("fan"), body("rail")]);
    ghosts.endBodyMoveGhost(false);
    const w = drag.clone().multiply(SLANTED);
    expect([drawn(rebuilt.mesh), drawn(rebuilt.edges.object)]).toEqual([expected("shroud", w), expected("shroud", w)]);
  });
});
