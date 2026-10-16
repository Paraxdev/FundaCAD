import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { traceCameraFor } from "../../src/viewport/pathtrace/camera";
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
