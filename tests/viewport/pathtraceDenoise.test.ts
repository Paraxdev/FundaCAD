import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { OidnPass, type OidnLike } from "../../src/viewport/pathtrace/oidnPass";
import { CROSSFADE_MS, FinalDenoise, type DenoisePass } from "../../src/viewport/pathtrace/denoise";

class FakePass implements DenoisePass {
  runs = 0;
  cancels = 0;
  pending: ((ok: boolean) => void)[] = [];
  fail = false;
  run() {
    this.runs++;
    if (this.fail) return Promise.reject(new Error("weights missing"));
    return new Promise<boolean>((r) => this.pending.push(r));
  }
  cancel() {
    this.cancels++;
  }
  finish(ok = true) {
    for (const r of this.pending.splice(0)) r(ok);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("final denoise", () => {
  it("runs one pass at the cap, crossfades to it, then settles", async () => {
    const p = new FakePass();
    const d = new FinalDenoise(p);
    expect(d.step(0)).toEqual({ mix: null, more: true });
    expect(d.step(16)).toEqual({ mix: null, more: true });
    expect(p.runs).toBe(1);
    p.finish();
    await flush();
    expect(d.step(100)).toEqual({ mix: 0, more: true });
    expect(d.step(100 + CROSSFADE_MS / 2).mix).toBeCloseTo(0.5);
    expect(d.denoised).toBe(false);
    expect(d.step(100 + CROSSFADE_MS)).toEqual({ mix: 1, more: false });
    expect(d.denoised).toBe(true);
    expect(d.step(500)).toEqual({ mix: null, more: false });
    expect(p.runs).toBe(1);
  });

  it("drops a denoise from before a camera move", async () => {
    const p = new FakePass();
    const d = new FinalDenoise(p);
    d.step(0);
    d.reset();
    expect(p.cancels).toBe(1);
    p.finish();
    await flush();
    expect(d.denoised).toBe(false);
    expect(d.step(10)).toEqual({ mix: null, more: true });
    expect(p.runs).toBe(2);
    expect(d.step(20).mix).toBeNull();
  });

  it("settles on the raw image when the pass fails or is dropped", async () => {
    const failing = new FakePass();
    failing.fail = true;
    const a = new FinalDenoise(failing);
    a.step(0);
    await flush();
    expect(a.step(10)).toEqual({ mix: null, more: false });
    expect(a.denoised).toBe(false);

    const dropped = new FakePass();
    const b = new FinalDenoise(dropped);
    b.step(0);
    dropped.finish(false);
    await flush();
    expect(b.step(10)).toEqual({ mix: null, more: false });
  });

  it("settles at once with denoise off, and a new pass starts over", async () => {
    const d = new FinalDenoise(null);
    expect(d.step(0)).toEqual({ mix: null, more: false });
    const p = new FakePass();
    d.setPass(p);
    expect(d.step(10).more).toBe(true);
    expect(p.runs).toBe(1);
  });
});

class StubOidn implements OidnLike {
  complete = false;
  running = false;
  texture: THREE.Texture | null = null;
  camera: THREE.Camera | null = null;
  guidesFrom: THREE.Camera | null = null;
  setScene(_s: THREE.Scene, c: THREE.Camera) { this.camera = c; }
  _renderAuxiliaryBuffers() {
    this.guidesFrom = this.camera;
    return { textures: [new THREE.Texture(), new THREE.Texture()] };
  }
  async denoise() { this.running = true; }
  reset() { this.running = false; this.complete = false; }
  dispose() {}
  land() { this.running = false; this.complete = true; this.texture = new THREE.Texture(); }
}

describe("oidn pass", () => {
  it("draws its guides from the camera the tracer holds now, after a lens change", async () => {
    const o = new StubOidn();
    const color = new THREE.Texture({ width: 4, height: 3 });
    const pinhole = new THREE.PerspectiveCamera();
    const src = { scene: new THREE.Scene(), camera: pinhole as THREE.Camera, color };
    o.setScene(src.scene, pinhole);
    const lens = new THREE.PerspectiveCamera();
    src.camera = lens;
    const pass = new OidnPass(o, () => src);
    const done = pass.run();
    await flush();
    expect(o.guidesFrom).toBe(lens);
    expect(pass.texture).toBeNull();
    o.land();
    expect(await done).toBe(true);
    expect(pass.texture).toBe(o.texture);
  });

  it("resolves false when cancelled mid pass", async () => {
    const o = new StubOidn();
    const src = { scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera() as THREE.Camera, color: new THREE.Texture({ width: 2, height: 2 }) };
    const pass = new OidnPass(o, () => src);
    const done = pass.run();
    await flush();
    pass.cancel();
    expect(await done).toBe(false);
  });
});
