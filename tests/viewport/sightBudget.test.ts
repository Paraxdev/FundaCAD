// A hover pick casts sight rays at hidden edge candidates only until their body tests reach a budget, so a zoomed out
// assembly, where every body lies near every sight ray, cannot stall the pointer.

import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Picker, SIGHT_TEST_BUDGET, sightBudget } from "../../src/viewport/picking";
import { boxView, placed, type Lump } from "./boxBodies";

describe("sightBudget", () => {
  it("grants rays until the spent tests reach the budget, and the ray that crosses it", () => {
    const take = sightBudget(1000);
    expect([300, 300, 300, 300, 300, 1].map(take)).toEqual([true, true, true, true, false, false]);
  });

  it("stops exactly at the budget and always grants the first ray", () => {
    const exact = sightBudget(900);
    expect([300, 300, 300, 1].map(exact)).toEqual([true, true, true, false]);
    const huge = sightBudget(50);
    expect([5000, 1].map(huge)).toEqual([true, false]);
  });
});

const W = 900,
  H = 640;
const RECT = { left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect;
const camera = new THREE.PerspectiveCamera(40, W / H, 0.1, 50_000);
camera.position.set(-130, 210, 95);
const aim = new THREE.Vector3(37, -18, 11);
camera.lookAt(aim);
camera.updateMatrixWorld(true);
camera.updateProjectionMatrix();
const sight = aim.clone().sub(camera.position).normalize();
const along = (t: number) => camera.position.clone().addScaledVector(sight, t);

// A wall across the line of sight, and behind it `n` small slanted boxes threaded on the pointer ray, so every one of
// their edges is a hidden candidate within a pixel or two of the pointer.
function hiddenStack(n: number): Lump[] {
  const lumps: Lump[] = [
    { id: "wall", body: "wall", size: [160, 150, 4], m: placed(along(140), new THREE.Euler(0.2, -0.3, 0.1)) },
  ];
  for (let i = 0; i < n; i++) {
    const rot = new THREE.Euler(0.3 + i * 0.37, -0.5 + i * 0.21, 0.2 + i * 0.13);
    lumps.push({ id: `b${i}`, body: `b${i}`, size: [1.1, 0.9, 1.3], m: placed(along(170 + i * 6), rot) });
  }
  return lumps;
}

function hover(n: number, edgeTool = false) {
  const v = boxView(hiddenStack(n), W, H);
  const picker = new Picker();
  const rays = vi.spyOn(picker as unknown as { pointVisible: () => boolean }, "pointVisible");
  const s = aim.clone().project(camera);
  const [x, y] = [(s.x * 0.5 + 0.5) * W, (-s.y * 0.5 + 0.5) * H];
  const hit = edgeTool
    ? picker.pickEdge(x, y, RECT, camera, v, { visibleOnly: true })
    : picker.pick(x, y, RECT, camera, v);
  return { hit, rays: rays.mock.calls.length, bodies: n + 1 };
}

describe("the hover pick's sight rays", () => {
  afterEach(() => vi.restoreAllMocks());

  it("casts a ray at every hidden candidate while the budget lasts", () => {
    const { hit, rays, bodies } = hover(6);
    expect(hit?.kind).toBe("face");
    expect(rays).toBeGreaterThan(6);
    expect(rays * bodies).toBeLessThan(SIGHT_TEST_BUDGET);
  });

  it("stops casting once the rays' body tests pass the budget, and still lands on the face", () => {
    const { hit, rays, bodies } = hover(400);
    expect(hit?.kind).toBe("face");
    expect(rays).toBe(Math.ceil(SIGHT_TEST_BUDGET / bodies));
  });

  it("bounds an edge tool's pick the same way, which finds no visible edge behind the wall", () => {
    const few = hover(6, true);
    expect(few.hit).toBeNull();
    expect(few.rays).toBeGreaterThan(6);
    expect(few.rays * few.bodies).toBeLessThan(SIGHT_TEST_BUDGET);
    const many = hover(400, true);
    expect(many.hit).toBeNull();
    expect(many.rays).toBe(Math.ceil(SIGHT_TEST_BUDGET / many.bodies));
  });
});
