import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { lensFor, traceCameraFor } from "../../src/viewport/pathtrace/camera";
import { PhysicalCamera } from "three-gpu-pathtracer/src/objects/PhysicalCamera.js";
import { collectBodies, mirrorBody, sceneSignature } from "../../src/viewport/pathtrace/mirror";

function body(): THREE.Mesh {
  const g = new THREE.BoxGeometry(2, 2, 2);
  const n = g.getAttribute("position").count;
  const baseColors = new Float32Array(n * 3).fill(0.5);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x3366cc, roughness: 0.3, metalness: 0.2 }));
  m.userData.owner = { id: "body1", baseColors };
  m.position.set(5, 0, 1);
  return m;
}

describe("mirror scene", () => {
  it("shares the vertex buffers but owns the index the tracer reorders", () => {
    const src = body();
    const before = Array.from(src.geometry.index!.array);
    const m = mirrorBody(src);
    expect(m.geometry).not.toBe(src.geometry);
    expect(m.geometry.getAttribute("position")).toBe(src.geometry.getAttribute("position"));
    expect(m.geometry.index!.array).not.toBe(src.geometry.index!.array);
    (m.geometry.index!.array as Uint16Array).reverse();
    (m.geometry as unknown as { boundsTree: object }).boundsTree = {};
    expect(Array.from(src.geometry.index!.array)).toEqual(before);
    expect((src.geometry as unknown as { boundsTree?: object }).boundsTree).toBeUndefined();
  });

  it("colours from the base colours, so a hover tint never reaches the trace", () => {
    const src = body();
    const m = mirrorBody(src);
    const c = m.geometry.getAttribute("color");
    expect(c.getX(0)).toBeCloseTo(0.5);
    const sig = sceneSignature([src]);
    src.geometry.setAttribute("color", new THREE.BufferAttribute(new Float32Array(c.count * 3).fill(1), 3));
    expect(sceneSignature([src])).toBe(sig);
    const mat = m.material as THREE.MeshPhysicalMaterial;
    expect(mat.vertexColors).toBe(true);
    expect(mat.roughness).toBeCloseTo(0.3);
    expect(mat.metalness).toBeCloseTo(0.2);
  });

  it("sits where the body sits and the signature follows a move or a finish change", () => {
    const scene = new THREE.Scene();
    const src = body();
    scene.add(src);
    const m = mirrorBody(src);
    expect(m.matrixWorld.elements[12]).toBe(5);
    const sig = sceneSignature(collectBodies(scene));
    src.position.x = 6;
    const moved = sceneSignature(collectBodies(scene));
    expect(moved).not.toBe(sig);
    (src.material as THREE.MeshStandardMaterial).roughness = 0.9;
    expect(sceneSignature(collectBodies(scene))).not.toBe(moved);
    src.visible = false;
    expect(collectBodies(scene)).toHaveLength(0);
  });
});

describe("trace camera", () => {
  it("is a copy, so the tracer never touches the viewport camera", () => {
    const cam = new THREE.PerspectiveCamera(40, 1.5, 0.1, 1000);
    cam.position.set(1, 2, 3);
    cam.updateMatrixWorld();
    const t = traceCameraFor(cam, null);
    expect(t).not.toBe(cam);
    (t as THREE.PerspectiveCamera).fov = 10;
    expect(cam.fov).toBe(40);
    cam.position.set(4, 5, 6);
    cam.updateMatrixWorld();
    const again = traceCameraFor(cam, t);
    expect(again).toBe(t);
    expect(again.position.x).toBe(4);
    expect((again as THREE.PerspectiveCamera).fov).toBe(40);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    expect(traceCameraFor(ortho, t)).not.toBe(t);
  });
});

describe("trace lens", () => {
  const cam = new THREE.PerspectiveCamera(45, 1.6, 0.1, 1000);

  it("is a pinhole on an orthographic camera or with the blur off", () => {
    expect(lensFor(new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100), 200, 2.8, 1)).toBeNull();
    expect(lensFor(cam, 200, 2.8, 0)).toBeNull();
  });

  it("opens with the blur and is capped by it like the Realtime pass", () => {
    const half = Math.tan(THREE.MathUtils.degToRad(22.5)) * 1.6;
    const lens = lensFor(cam, 200, 2.8, 1)!;
    expect(lens.focusDistance).toBe(200);
    // A quarter of the focus distance in front, the lens blurs as far as the
    // pass's cap, 0.4 * 0.012 * blur of the width.
    const d = 0.75 * 200;
    expect((lens.apertureRadius * (200 - d)) / d / (2 * 200 * half)).toBeCloseTo(0.4 * 0.012, 6);
    const wide = lensFor(cam, 2, 2.8, 1)!;
    // Close up the slope at the focus is the limit: 0.4 * 0.006 / fStop per mm.
    expect(wide.apertureRadius / (2 * 2 * 2 * half)).toBeCloseTo((0.4 * 0.006) / 2.8, 6);
  });

  it("gives the tracer a physical camera focused where the lens says, in millimetres", () => {
    const t = traceCameraFor(cam, null, { focusDistance: 150, apertureRadius: 1.5 }) as PhysicalCamera;
    expect(t).toBeInstanceOf(PhysicalCamera);
    expect(t.focusDistance).toBe(150);
    expect(t.bokehSize * 0.5 * 1e-3).toBeCloseTo(1.5);
    expect(t.fov).toBe(45);
    const again = traceCameraFor(cam, t, { focusDistance: 90, apertureRadius: 1.5 }) as PhysicalCamera;
    expect(again).toBe(t);
    expect(again.focusDistance).toBe(90);
    expect(again.bokehSize * 0.5 * 1e-3).toBeCloseTo(1.5);
    expect(traceCameraFor(cam, t, null)).not.toBeInstanceOf(PhysicalCamera);
  });
});
