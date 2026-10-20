import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { handleList, handlePoint, overHandle, type HandleHost } from "../../src/harness/handles";
import { createDragHandle, createRotationArc, nameHandle } from "../../src/features/manipulator";
import { HarnessError } from "../../src/harness/locate";

const W = 800, H = 600;

/** One world unit is one pixel, looking down -Z, so +Y is up the screen. */
function rig() {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-W / 2, W / 2, H / 2, -H / 2, 0.1, 1000);
  camera.position.set(0, 0, 500);
  camera.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  const h = {
    viewport: {
      scene: { scene },
      domElement: {} as HTMLCanvasElement,
      pixelWorldSize: () => 1,
      projectToScreen: (w: THREE.Vector3) => {
        const v = w.clone().project(camera);
        return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
      },
      rayFrom: (x: number, y: number) => {
        rc.setFromCamera(new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1), camera);
        return rc;
      },
    },
  } as unknown as HandleHost;
  return { h, scene };
}

const all = () => true;

function err(fn: () => unknown): HarnessError {
  try { fn(); } catch (e) { if (e instanceof HarnessError) return e; throw e; }
  throw new Error("expected a harness error");
}

describe("named handles", () => {
  it("finds a visible handle, aims inside its grab volume and reads its drag axis", () => {
    const { h, scene } = rig();
    const push = nameHandle(createDragHandle(), "push");
    push.group.position.set(100, 0, 0);
    scene.add(push.group);
    const p = handlePoint(h, "push", all);
    expect(p.name).toBe("push");
    expect(Math.abs(p.x - 500)).toBeLessThan(20);
    expect(p.y).toBeLessThan(300);
    expect(p.dir[0]).toBeCloseTo(0);
    expect(p.dir[1]).toBeCloseTo(-1);
    expect(p.pxPerMm).toBeCloseTo(1);
  });

  it("follows the handle's own turn for the drag direction", () => {
    const { h, scene } = rig();
    const d = nameHandle(createDragHandle(), "depth");
    d.group.rotation.z = -Math.PI / 2;
    scene.add(d.group);
    const p = handlePoint(h, "depth", all);
    expect(p.dir[0]).toBeCloseTo(1);
    expect(p.dir[1]).toBeCloseTo(0);
  });

  it("finds a ring shaped handle on its band", () => {
    const { h, scene } = rig();
    scene.add(nameHandle(createRotationArc(), "taper").group);
    expect(handlePoint(h, "taper", all).name).toBe("taper");
  });

  it("skips a handle under a hidden parent and lists what is there", () => {
    const { h, scene } = rig();
    const hidden = new THREE.Group();
    hidden.visible = false;
    hidden.add(nameHandle(createDragHandle(), "angle").group);
    scene.add(hidden, nameHandle(createDragHandle(), "size").group);
    const e = err(() => handlePoint(h, "angle", all));
    expect(e.kind).toBe("NotFound");
    expect(e.candidates).toEqual(["size"]);
  });

  it("needs #n when two handles share a name", () => {
    const { h, scene } = rig();
    const a = nameHandle(createDragHandle(), "offset");
    const b = nameHandle(createDragHandle(), "offset");
    b.group.position.set(-200, 0, 0);
    scene.add(a.group, b.group);
    const e = err(() => handlePoint(h, "offset", all));
    expect(e.kind).toBe("Ambiguous");
    expect(e.candidates).toEqual(["offset#1", "offset#2"]);
    expect(handlePoint(h, "offset#2", all).x).toBeLessThan(300);
    expect(handleList(h, all).map((l) => l.split(" ")[0])).toEqual(["offset#1", "offset#2"]);
  });

  it("says Occluded when no point of it is on the canvas", () => {
    const { h, scene } = rig();
    scene.add(nameHandle(createDragHandle(), "push").group);
    expect(err(() => handlePoint(h, "push", () => false)).kind).toBe("Occluded");
    expect(handleList(h, () => false)).toEqual(["push covered"]);
  });

  it("tells when a press would land on a handle instead of the model", () => {
    const { h, scene } = rig();
    expect(overHandle(h, 400, 280)).toBe(false);
    scene.add(nameHandle(createDragHandle(), "origin").group);
    expect(overHandle(h, 400, 280)).toBe(true);
    expect(overHandle(h, 700, 100)).toBe(false);
  });
});
