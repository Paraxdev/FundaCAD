import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { FrameCameras, viewCamera } from "../../src/viewport/pathtrace/frameCamera";

function cam(x: number): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(50, 1.5, 0.1, 1000);
  c.position.set(x, -100, 50);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
}

const eyeX = (v: { matrices: Float64Array } | null) => (v ? v.matrices[12] : null);

describe("the camera of a native frame", () => {
  it("is the newest camera the tracer took before it drew the frame", () => {
    const k = new FrameCameras();
    k.send(cam(1))(0);
    k.send(cam(2))(3);
    k.send(cam(3))(4);
    expect(eyeX(k.of(3))).toBe(1);
    expect(eyeX(k.of(4))).toBe(2);
    expect(eyeX(k.of(5))).toBe(3);
  });

  it("counts a camera still in flight as not taken until its reply says so", () => {
    const k = new FrameCameras();
    k.send(cam(1))(0);
    const took = k.send(cam(2));
    expect(eyeX(k.of(6))).toBe(1);
    took(5);
    expect(eyeX(k.of(6))).toBe(2);
  });

  it("knows a camera taken after the frame was drawn did not draw it", () => {
    const k = new FrameCameras();
    k.send(cam(1))(0);
    k.send(cam(2))(6);
    expect(eyeX(k.of(6))).toBe(1);
  });

  it("keeps the newest answered camera however many cameras wait for a reply after it", () => {
    for (const waiting of [0, 1, 63, 64, 199]) {
      const k = new FrameCameras();
      k.send(cam(-2.5))(3);
      const replies = Array.from({ length: waiting }, (_, i) => k.send(cam(10 + i)));
      expect([eyeX(k.of(4)), eyeX(k.of(900))]).toEqual([-2.5, -2.5]);
      replies.at(-1)?.(7);
      expect([eyeX(k.of(4)), eyeX(k.of(8))]).toEqual([-2.5, waiting ? 10 + waiting - 1 : -2.5]);
    }
  });

  it("counts on past the seq wrapping round", () => {
    const k = new FrameCameras();
    k.send(cam(1))(0xfffffffe);
    k.send(cam(2))(0xffffffff);
    expect(eyeX(k.of(0xffffffff))).toBe(1);
    expect(eyeX(k.of(1))).toBe(2);
  });

  it("knows nothing of a frame older than every camera, or from a tracer that answers no seq", () => {
    const k = new FrameCameras();
    k.send(cam(1))(9);
    expect(k.of(4)).toBeNull();
    const old = new FrameCameras();
    old.send(cam(1))(null);
    expect(old.of(4)).toBeNull();
  });

  it("draws with the frame's matrices on a stand in, leaving the live camera as it is", () => {
    const live = cam(7);
    const k = new FrameCameras();
    k.send(cam(1))(0);
    const v = k.of(1)!;
    const c = viewCamera(live, v);
    expect(c).not.toBe(live);
    c.updateMatrixWorld();
    expect(c.matrixWorld.elements[12]).toBeCloseTo(1, 6);
    expect(c.matrixWorldInverse.clone().multiply(c.matrixWorld).elements[0]).toBeCloseTo(1, 6);
    expect(c.projectionMatrix.equals(cam(1).projectionMatrix)).toBe(true);
    expect(live.matrixWorld.elements[12]).toBeCloseTo(7, 6);
    expect(viewCamera(live, v)).toBe(c);
  });

  it("leaves the live camera on when the frame was traced with the other projection", () => {
    const k = new FrameCameras();
    k.send(cam(1))(0);
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
    expect(viewCamera(ortho, k.of(1)!)).toBe(ortho);
  });
});
