import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { bakeAllowed, casterKey, catcherPlane, catcherShown } from "../../src/viewport/contactShadow";

function body(x: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(10, 10, 10), new THREE.MeshStandardMaterial());
  m.position.x = x;
  m.userData.owner = { id: x };
  return m;
}

function model() {
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  const a = body(0);
  const b = body(30);
  group.add(a, b);
  scene.add(group);
  return { scene, group, a, b };
}

describe("caster key", () => {
  it("does not change when the camera or anything outside the model does", () => {
    const { scene, group } = model();
    const cam = new THREE.PerspectiveCamera();
    scene.add(cam);
    const k0 = casterKey(group);
    cam.position.set(100, -40, 20);
    cam.lookAt(0, 0, 0);
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(1), new THREE.MeshBasicMaterial()));
    expect(casterKey(group)).toEqual(k0);
  });

  it("changes on a move, a hide, a new geometry and an edited one", () => {
    const { group, a, b } = model();
    let k = casterKey(group);
    const changed = () => {
      const n = casterKey(group);
      const differs = JSON.stringify(n) !== JSON.stringify(k);
      k = n;
      return differs;
    };
    a.position.y = 4;
    expect(changed()).toBe(true);
    b.visible = false;
    expect(changed()).toBe(true);
    b.visible = true;
    expect(changed()).toBe(true);
    a.geometry = new THREE.BoxGeometry(10, 10, 12);
    expect(changed()).toBe(true);
    a.geometry.getAttribute("position").needsUpdate = true;
    expect(changed()).toBe(true);
    expect(changed()).toBe(false);
  });

  it("changes when a section plane moves, not when a colour does", () => {
    const { group, a } = model();
    const plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
    const mat = a.material as THREE.MeshStandardMaterial;
    mat.clippingPlanes = [plane];
    const k0 = casterKey(group);
    mat.color.set(0xff0000);
    expect(casterKey(group)).toEqual(k0);
    plane.constant = 3;
    expect(casterKey(group)).not.toEqual(k0);
  });

  it("skips what no body owns, such as a section ghost", () => {
    const { group, a } = model();
    const k0 = casterKey(group);
    const ghost = new THREE.Mesh(a.geometry, new THREE.MeshBasicMaterial());
    a.add(ghost);
    expect(casterKey(group)).toEqual(k0);
    ghost.position.z = 5;
    ghost.visible = false;
    expect(casterKey(group)).toEqual(k0);
  });
});

describe("catcher plane", () => {
  it("sits at the grid height under the middle of the model, wider than it", () => {
    const box = new THREE.Box3(new THREE.Vector3(20, -5, -3), new THREE.Vector3(40, 5, 17));
    const p = catcherPlane(box, -3)!;
    expect(p.z).toBe(-3);
    expect(p.centre).toEqual([30, 0]);
    expect(p.extent).toBeGreaterThan(20);
    expect(p.height).toBeCloseTo(20);
    expect(catcherPlane(box, 0)!.z).toBe(0);
  });

  it("grows with the footprint, keeps a floor for a tiny part, and is null for nothing", () => {
    const small = new THREE.Box3(new THREE.Vector3(0, 0, 0), new THREE.Vector3(1e-6, 1e-6, 1e-6));
    const big = new THREE.Box3(new THREE.Vector3(-100, -50, 0), new THREE.Vector3(100, 50, 10));
    expect(catcherPlane(small, 0)!.extent).toBeGreaterThan(0.5);
    expect(catcherPlane(big, 0)!.extent).toBeGreaterThan(
      catcherPlane(new THREE.Box3(new THREE.Vector3(-10, -5, 0), new THREE.Vector3(10, 5, 10)), 0)!.extent,
    );
    expect(catcherPlane(new THREE.Box3(), 0)).toBeNull();
  });
});

describe("when the catcher is drawn and baked", () => {
  const on = {
    ground: "shadow",
    lowPower: false,
    potato: false,
    viewMode: "realtime",
    tracing: false,
    xray: false,
  } as const;

  it("draws only for a shadow ground on the full render in Realtime", () => {
    expect(catcherShown(on)).toBe(true);
    expect(catcherShown({ ...on, ground: "none" })).toBe(false);
    expect(catcherShown({ ...on, lowPower: true })).toBe(false);
    expect(catcherShown({ ...on, potato: true })).toBe(false);
    expect(catcherShown({ ...on, viewMode: "matcap" })).toBe(false);
    expect(catcherShown({ ...on, xray: true })).toBe(false);
    expect(catcherShown({ ...on, viewMode: "pathtraced" })).toBe(true);
    expect(catcherShown({ ...on, viewMode: "pathtraced", tracing: true })).toBe(false);
  });

  it("does not bake while Path traced is tracing or done", () => {
    expect(bakeAllowed("trace")).toBe(false);
    expect(bakeAllowed("done")).toBe(false);
    for (const s of ["off", "hidden", "moving", "paused:section"] as const) expect(bakeAllowed(s)).toBe(true);
  });
});
