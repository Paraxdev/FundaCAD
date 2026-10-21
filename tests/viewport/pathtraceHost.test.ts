import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { TracerBackend } from "../../src/viewport/pathtrace/backend";
import { FIRST_SAMPLE_TIMEOUT_MS, IDLE_DISPOSE_MS, PathTraceHost, type TraceFrame } from "../../src/viewport/pathtrace/host";
import { TRIANGLE_BUDGET } from "../../src/viewport/pathtrace/mirror";
import { STILL_MS } from "../../src/viewport/pathtrace/state";

const ENV = new THREE.Texture();
const CAMERA = new THREE.PerspectiveCamera();

class FakeTracer implements TracerBackend {
  readonly name = "fake";
  readonly canvas = { style: {} as Record<string, string> } as unknown as HTMLCanvasElement;
  readonly maxStorageBytes = Infinity;
  calls: string[] = [];
  count = 0;
  pending: ((n: number) => void)[] = [];
  faultCb: ((why: string) => void) | null = null;
  async init() {}
  setSize() { this.calls.push("size"); }
  setScene() { this.calls.push("scene"); }
  updateGeometry() { this.calls.push("geometry"); }
  updateTransforms() { this.calls.push("transforms"); }
  updateMaterials() { this.calls.push("materials"); }
  updateLook() { this.calls.push("look"); }
  updateCamera() { this.calls.push("camera"); }
  reset() { this.calls.push("reset"); }
  readonly maxTextureSize = 8192;
  frameMs = 5;
  /** Set to hold renderSample's GPU time until `land()`. */
  holdFrames = false;
  private held: ((ms: number) => void)[] = [];
  renderSample() {
    this.calls.push("sample");
    if (!this.holdFrames) return Promise.resolve(this.frameMs);
    return new Promise<number>((r) => this.held.push(r));
  }
  land() { for (const r of this.held.splice(0)) r(this.frameMs); }
  setFrameBudget(n: number) { this.calls.push(`budget:${n}`); }
  setRenderScale(n: number) { this.calls.push(`scale:${n}`); }
  setCap(n: number) { this.calls.push(`cap:${n}`); }
  setMotionPreview(on: boolean) { this.calls.push(`preview:${on}`); }
  pictureDone: ((url: string) => void) | null = null;
  pictureSize = { width: 0, height: 0, samples: 0 };
  picture(o: { width: number; height: number; samples: number }) {
    this.calls.push("picture");
    this.pictureSize = { width: o.width, height: o.height, samples: o.samples };
    return new Promise<string>((r) => (this.pictureDone = r));
  }
  more = true;
  denoised = false;
  present() { this.calls.push("present"); return this.more; }
  setDenoise(level: string) { this.calls.push(`denoise:${level}`); }
  setBloom(b: { strength: number } | null) { this.calls.push(`bloom:${b ? b.strength.toFixed(3) : "off"}`); }
  samples() { return new Promise<number>((r) => this.pending.push(r)); }
  dispose() { this.calls.push("dispose"); }
  onFault(cb: (why: string) => void) { this.faultCb = cb; }
  answer(n: number) { for (const r of this.pending.splice(0)) r(n); }
}

class FakeGuard {
  set = false;
  async arm() { this.set = true; }
  clear() { this.set = false; }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const glCanvas = { clientWidth: 800, clientHeight: 600, offsetLeft: 0, offsetTop: 0, style: {}, parentElement: null } as unknown as HTMLCanvasElement;

function scene(): THREE.Scene {
  const s = new THREE.Scene();
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial());
  m.userData.owner = { baseColors: new Float32Array(m.geometry.getAttribute("position").count * 3) };
  s.add(m);
  return s;
}

function bigScene(): THREE.Scene {
  const s = new THREE.Scene();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array((TRIANGLE_BUDGET + 100_000) * 3), 1));
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial());
  m.userData.owner = {};
  s.add(m);
  return s;
}

function frame(over: Partial<TraceFrame["inputs"]> = {}, now = 1000, extra: Partial<TraceFrame> = {}): TraceFrame {
  return {
    now,
    inputs: { mode: "pathtraced", visible: true, stillMs: 1000, sectioned: false, xray: false, wireframe: false, sketchOpen: false, ...over },
    camera: CAMERA,
    cameraChanged: false,
    sceneMaybeChanged: false,
    root: extra.root ?? scene(),
    look: () => ({ lights: [], background: new THREE.Color(), environment: ENV, brightness: 1, toneMapping: THREE.NeutralToneMapping, exposure: 1 }),
    lens: () => null,
    ...extra,
  };
}

async function started(): Promise<{ host: PathTraceHost; t: FakeTracer; created: () => number }> {
  const t = new FakeTracer();
  let n = 0;
  const host = new PathTraceHost(glCanvas, async () => { n++; return t; }, new FakeGuard());
  host.tick(frame());
  await flush();
  await flush();
  return { host, t, created: () => n };
}

describe("path trace host", () => {
  it("loads no tracer until Path traced is drawn", async () => {
    let n = 0;
    const host = new PathTraceHost(glCanvas, async () => { n++; return new FakeTracer(); });
    host.tick(frame({ mode: "realtime" }));
    host.tick(frame({ mode: "matcap" }));
    await flush();
    expect(n).toBe(0);
    expect(host.state).toBe("off");
  });

  it("traces when still, shows the image after the first sample and stops at the cap", async () => {
    const { host, t, created } = await started();
    expect(created()).toBe(1);
    host.tick(frame());
    expect(t.calls).toContain("scene");
    expect(t.calls.filter((c) => c === "sample")).toHaveLength(1);
    expect(host.shown).toBe(false);
    t.answer(1);
    await flush();
    host.tick(frame());
    expect(host.shown).toBe(true);
    t.answer(256);
    await flush();
    t.calls.length = 0;
    t.more = false;
    host.tick(frame());
    host.tick(frame());
    expect(host.state).toBe("done");
    expect(t.calls).not.toContain("sample");
    expect(host.shown).toBe(true);
  });

  it("keeps presenting at the cap until the denoise settles, then idles", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(256);
    await flush();
    t.calls.length = 0;
    host.tick(frame());
    host.tick(frame());
    expect(host.state).toBe("done");
    expect(t.calls).toEqual(["present", "present"]);
    t.more = false;
    t.denoised = true;
    host.tick(frame());
    t.calls.length = 0;
    host.tick(frame());
    host.tick(frame());
    expect(t.calls).toEqual([]);
    expect(host.denoised).toBe(true);
  });

  it("a new denoise level presents again at the cap without restarting the samples", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(256);
    await flush();
    t.more = false;
    host.tick(frame());
    t.calls.length = 0;
    host.tick(frame({}, 1000, { denoise: "high" }));
    expect(t.calls).toEqual(["denoise:high", "present"]);
    expect(host.samples).toBe(256);
  });

  it("a bloom change draws the finished image again without restarting the samples", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(256);
    await flush();
    t.more = false;
    host.tick(frame());
    t.calls.length = 0;
    host.tick(frame({}, 1000, { bloom: 0.6, bloomable: true }));
    host.tick(frame({}, 1010, { bloom: 0.6, bloomable: true }));
    expect(t.calls).toEqual(["bloom:0.252"]);
    expect(host.samples).toBe(256);
    expect(host.state).toBe("done");
    t.calls.length = 0;
    host.tick(frame({}, 1020, { bloom: 0, bloomable: true }));
    expect(t.calls).toEqual(["bloom:off"]);
  });

  it("asks for no bloom while nothing on screen can reach the threshold", async () => {
    const { host, t } = await started();
    host.tick(frame({}, 1000, { bloom: 0.5, bloomable: false }));
    expect(t.calls.filter((c) => c.startsWith("bloom"))).toEqual([]);
    host.tick(frame({}, 1010, { bloom: 0.5, bloomable: true }));
    expect(t.calls.filter((c) => c.startsWith("bloom"))).toEqual(["bloom:0.175"]);
  });

  it("presents again at the next cap after a camera move", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(256);
    await flush();
    t.more = false;
    host.tick(frame());
    host.tick(frame({}, 1010, { cameraChanged: true }));
    host.tick(frame({}, 1015));
    t.answer(256);
    await flush();
    t.calls.length = 0;
    host.tick(frame({}, 1020));
    expect(t.calls).toContain("present");
  });

  it("shows Realtime and spends nothing while moving or paused, by default", async () => {
    const { host, t } = await started();
    for (const over of [{ stillMs: 10 }, { sectioned: true }, { xray: true }, { wireframe: true }, { sketchOpen: true }, { visible: false }]) {
      t.calls.length = 0;
      host.tick(frame(over));
      expect(t.calls).not.toContain("sample");
      expect(host.shown).toBe(false);
    }
  });

  it("keeps the traced picture up and traces every frame of an orbit with Realtime while moving off", async () => {
    const { host, t } = await started();
    const off = { realtimeWhileMoving: false };
    host.tick(frame(off));
    t.answer(8);
    await flush();
    host.tick(frame(off, 1010));
    expect(host.shown).toBe(true);
    t.calls.length = 0;
    const shown: boolean[] = [];
    for (let i = 0; i < 10; i++) {
      host.tick(frame({ ...off, stillMs: 5 }, 1100 + i * 16, { cameraChanged: true }));
      shown.push(host.shown);
      t.answer(1);
      await flush();
    }
    expect(host.state).toBe("trace");
    expect(shown).toEqual(Array(10).fill(true));
    expect(t.calls.filter((c) => c === "reset")).toHaveLength(10);
    expect(t.calls.filter((c) => c === "sample").length).toBeGreaterThanOrEqual(9);
  });

  it("asks the tracer for its own preview of each restart only with Realtime while moving off", async () => {
    const { host, t } = await started();
    const previews = () => t.calls.filter((c) => c.startsWith("preview:"));
    host.tick(frame());
    expect(previews()).toEqual([]);
    host.tick(frame({ realtimeWhileMoving: false }, 1010));
    host.tick(frame({ realtimeWhileMoving: false }, 1020));
    expect(previews()).toEqual(["preview:true"]);
    host.tick(frame({}, 1030));
    expect(previews()).toEqual(["preview:true", "preview:false"]);
  });

  it("gives the overlay the traced frame's camera only with Realtime while moving off", async () => {
    const { host, t } = await started();
    const view = { matrices: new Float64Array(32), ortho: false };
    (t as unknown as { shownView: () => typeof view }).shownView = () => view;
    const off = { realtimeWhileMoving: false };
    host.tick(frame(off));
    t.answer(8);
    await flush();
    host.tick(frame(off, 1010));
    expect(host.shown).toBe(true);
    expect(host.frameView).toBe(view);
    host.tick(frame({}, 1020));
    expect(host.shown).toBe(true);
    expect(host.frameView).toBeNull();
  });

  it("drops to Realtime on a resize with Realtime while moving off, the resized canvas is blank", async () => {
    const { host, t } = await started();
    const off = { realtimeWhileMoving: false };
    host.tick(frame(off));
    t.answer(8);
    await flush();
    host.tick(frame(off, 1010));
    expect(host.shown).toBe(true);
    const wide = { ...glCanvas, clientWidth: 1000 } as unknown as HTMLCanvasElement;
    (host as unknown as { webglCanvas: HTMLCanvasElement }).webglCanvas = wide;
    host.tick(frame(off, 1020, { cameraChanged: true }));
    expect(host.shown).toBe(false);
  });

  it("goes back to the trace once the view rests after an orbit", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(8);
    await flush();
    host.tick(frame({}, 1010));
    expect(host.shown).toBe(true);
    t.answer(8);
    await flush();
    for (let i = 0; i < 5; i++) host.tick(frame({ stillMs: 5 }, 1100 + i * 16, { cameraChanged: true }));
    expect(host.state).toBe("moving");
    expect(host.shown).toBe(false);
    await flush();
    t.calls.length = 0;
    host.tick(frame({ stillMs: STILL_MS }, 1300));
    expect(host.state).toBe("trace");
    expect(t.calls).toContain("reset");
    expect(t.calls).toContain("sample");
    expect(host.shown).toBe(false);
    t.answer(1);
    await flush();
    host.tick(frame({}, 1320));
    expect(host.shown).toBe(true);
  });

  it("draws Realtime while a body is being moved by an edit, and traces once edits stop", async () => {
    const root = scene();
    const { host, t } = await started();
    host.tick(frame({}, 1000, { root }));
    t.answer(8);
    await flush();
    host.tick(frame({}, 1010, { root }));
    expect(host.shown).toBe(true);
    root.children[0]!.position.x = 3;
    root.children[0]!.updateMatrixWorld();
    t.calls.length = 0;
    host.tick(frame({}, 1020, { root, sceneMaybeChanged: true }));
    expect(host.shown).toBe(false);
    expect(t.calls).not.toContain("sample");
    host.tick(frame({}, 1020 + STILL_MS - 10, { root }));
    expect(host.state).toBe("moving");
    expect(t.calls).not.toContain("sample");
    await flush();
    host.tick(frame({}, 1020 + STILL_MS + 10, { root }));
    expect(host.state).toBe("trace");
    expect(t.calls).toContain("sample");
  });

  it("keeps the traced picture up through an edit with Realtime while moving off", async () => {
    const root = scene();
    const { host, t } = await started();
    const off = { realtimeWhileMoving: false };
    host.tick(frame(off, 1000, { root }));
    t.answer(8);
    await flush();
    host.tick(frame(off, 1010, { root }));
    await flush();
    root.children[0]!.position.x = 3;
    root.children[0]!.updateMatrixWorld();
    t.calls.length = 0;
    host.tick(frame(off, 1020, { root, sceneMaybeChanged: true }));
    expect(host.state).toBe("trace");
    expect(host.shown).toBe(true);
    expect(t.calls).toContain("transforms");
    expect(t.calls).toContain("sample");
  });

  it("drops a sample count from before a camera move", async () => {
    const { host, t } = await started();
    host.tick(frame());
    host.tick(frame({}, 1010, { cameraChanged: true }));
    expect(t.calls).toContain("camera");
    t.answer(40);
    await flush();
    expect(host.samples).toBe(0);
    host.tick(frame());
    t.answer(2);
    await flush();
    expect(host.samples).toBe(2);
  });

  it("restarts on a camera that moved without a cameraChanged flag, an arrow key step", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(256);
    await flush();
    expect(host.samples).toBe(256);
    const stepped = new THREE.PerspectiveCamera();
    stepped.position.x = 5;
    stepped.updateMatrixWorld();
    t.calls.length = 0;
    host.tick(frame({}, 1010, { camera: stepped }));
    expect(t.calls).toContain("camera");
    expect(host.samples).toBe(0);
    t.calls.length = 0;
    host.tick(frame({}, 1020, { camera: stepped }));
    host.tick(frame({}, 1030, { camera: stepped }));
    expect(t.calls).not.toContain("camera");
  });

  it("restarts once on a projection switch, and not again on the same camera", async () => {
    const { host, t } = await started();
    host.tick(frame());
    const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    t.calls.length = 0;
    host.tick(frame({}, 1010, { camera: ortho }));
    host.tick(frame({}, 1020, { camera: ortho }));
    expect(t.calls.filter((c) => c === "camera")).toHaveLength(1);
  });

  it("does not touch the scene on a hover, and refits it when a body moves", async () => {
    const root = scene();
    const { host, t } = await started();
    host.tick(frame({}, 1000, { root }));
    const scenes = () => t.calls.filter((c) => c === "scene").length;
    const before = scenes();
    host.tick(frame({}, 1000, { root, sceneMaybeChanged: true }));
    expect(scenes()).toBe(before);
    root.children[0]!.position.x = 3;
    host.tick(frame({}, 1000, { root, sceneMaybeChanged: true }));
    expect(scenes()).toBe(before);
    expect(t.calls.filter((c) => c === "transforms")).toHaveLength(1);
  });

  it("drops to Realtime on a GPU fault and turns off after the second", async () => {
    const faults: [string, boolean][] = [];
    const t = new FakeTracer();
    const host = new PathTraceHost(glCanvas, async () => t);
    host.onFault = (why, off) => faults.push([why, off]);
    host.tick(frame());
    await flush();
    await flush();
    t.faultCb!("GPU device lost");
    expect(faults).toEqual([["GPU device lost", false]]);
    expect(t.calls).toContain("dispose");
    host.tick(frame());
    await flush();
    await flush();
    t.faultCb!("GPU validation");
    expect(faults[1]).toEqual(["GPU validation", true]);
    expect(host.disabled).toBe(true);
    host.tick(frame());
    expect(host.state).toBe("off");
  });

  it("gives up when no sample arrives within the timeout", async () => {
    const faults: string[] = [];
    const { host } = await started();
    host.onFault = (why) => faults.push(why);
    host.tick(frame({}, 1000));
    host.tick(frame({}, 1000 + FIRST_SAMPLE_TIMEOUT_MS + 1));
    expect(faults).toHaveLength(1);
  });

  it("reports a failed start as a fault", async () => {
    const faults: string[] = [];
    const host = new PathTraceHost(glCanvas, async () => { throw new Error("no adapter"); });
    host.onFault = (why) => faults.push(why);
    host.tick(frame());
    await flush();
    await flush();
    expect(faults[0]).toMatch(/no adapter/);
  });

  it("refuses a model over the triangle budget with a note, never as a GPU fault", async () => {
    const faults: string[] = [];
    const notes: string[] = [];
    let n = 0;
    const host = new PathTraceHost(glCanvas, async () => { n++; return new FakeTracer(); }, new FakeGuard());
    host.onFault = (why) => faults.push(why);
    host.onRefuse = (why) => notes.push(why);
    const root = bigScene();
    for (const now of [1000, 2000, 1000 + FIRST_SAMPLE_TIMEOUT_MS + 1, 1000 + 3 * FIRST_SAMPLE_TIMEOUT_MS]) {
      host.tick(frame({}, now, { root }));
      await flush();
      await flush();
    }
    expect(notes).toEqual(["Path tracing is limited to 3 million triangles for now, this model has 3.1 million"]);
    expect(faults).toEqual([]);
    expect(host.disabled).toBe(false);
    expect(n).toBe(0);
  });

  it("refuses a model that grows past the budget while tracing, without a fault", async () => {
    const faults: string[] = [];
    const notes: string[] = [];
    const t = new FakeTracer();
    const host = new PathTraceHost(glCanvas, async () => t, new FakeGuard());
    host.onFault = (why) => faults.push(why);
    host.onRefuse = (why) => notes.push(why);
    host.tick(frame());
    await flush();
    await flush();
    const root = bigScene();
    host.tick(frame({}, 1000, { root, sceneMaybeChanged: true }));
    host.tick(frame({}, 1000 + FIRST_SAMPLE_TIMEOUT_MS + 1, { root, sceneMaybeChanged: true }));
    expect(notes).toHaveLength(1);
    expect(faults).toEqual([]);
    expect(host.shown).toBe(false);
  });

  it("arms the crash guard only while a first sample is wanted", async () => {
    const guard = new FakeGuard();
    const t = new FakeTracer();
    let n = 0;
    const host = new PathTraceHost(glCanvas, async () => { n++; return t; }, guard);
    host.tick(frame({ sketchOpen: true }));
    host.tick(frame({ visible: false }));
    await flush();
    expect(guard.set).toBe(false);
    expect(n).toBe(0);
    host.tick(frame());
    await flush();
    await flush();
    expect(guard.set).toBe(true);
    host.tick(frame({ xray: true }));
    await flush();
    expect(guard.set).toBe(false);
    host.tick(frame());
    await flush();
    expect(guard.set).toBe(true);
    t.answer(1);
    await flush();
    expect(guard.set).toBe(false);
  });

  it("frees the tracer a while after leaving Path traced and starts again on the next pick", async () => {
    const created: FakeTracer[] = [];
    const host = new PathTraceHost(glCanvas, async () => { const t = new FakeTracer(); created.push(t); return t; }, new FakeGuard());
    host.tick(frame({}, 1000));
    await flush();
    await flush();
    host.tick(frame({ mode: "realtime" }, 2000));
    host.tick(frame({ mode: "realtime" }, 2000 + IDLE_DISPOSE_MS - 1));
    expect(created[0]!.calls).not.toContain("dispose");
    host.tick(frame({ mode: "realtime" }, 2000 + IDLE_DISPOSE_MS + 1));
    expect(created[0]!.calls).toContain("dispose");
    expect(host.backendName).toBe("");
    host.tick(frame({}, 70_000));
    await flush();
    await flush();
    expect(created).toHaveLength(2);
  });

  it("hands a changed look to the tracer after the first scene, once, with a restart", async () => {
    const { host, t } = await started();
    host.tick(frame());
    expect(t.calls).toContain("scene");
    t.calls.length = 0;
    const brighter = () => ({ ...frame().look(), brightness: 1.6, background: new THREE.Color(0.8, 0.8, 0.8) });
    host.tick(frame({}, 1100, { sceneMaybeChanged: true, look: brighter }));
    expect(t.calls.filter((c) => c === "look")).toHaveLength(1);
    expect(t.calls.indexOf("reset")).toBeGreaterThan(t.calls.indexOf("look"));
    t.calls.length = 0;
    host.tick(frame({}, 1200, { sceneMaybeChanged: true, look: brighter }));
    expect(t.calls).not.toContain("look");
  });

  // The rig swaps a perspective and an orthographic camera object on a
  // projection change and reports no move, so the swap alone has to count.
  it("re-reads the camera when the projection swaps it without a camera move", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.calls.length = 0;
    const ortho = new THREE.OrthographicCamera();
    host.tick(frame({}, 1100, { camera: ortho }));
    expect(t.calls).toContain("camera");
    t.calls.length = 0;
    host.tick(frame({}, 1200, { camera: ortho }));
    expect(t.calls).not.toContain("camera");
  });

  it("re-reads the camera when the lens changes without a camera move", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.calls.length = 0;
    host.tick(frame({}, 1100, { lens: () => ({ focusDistance: 200, apertureRadius: 1 }) }));
    expect(t.calls).toContain("camera");
    t.calls.length = 0;
    host.tick(frame({}, 1200, { lens: () => ({ focusDistance: 200, apertureRadius: 1 }) }));
    expect(t.calls).not.toContain("camera");
  });

  it("waits for the last frame to leave the GPU before handing it another", async () => {
    const { host, t } = await started();
    t.holdFrames = true;
    host.tick(frame());
    host.tick(frame());
    host.tick(frame());
    expect(t.calls.filter((c) => c === "sample")).toHaveLength(1);
    t.land();
    await flush();
    host.tick(frame());
    expect(t.calls.filter((c) => c === "sample")).toHaveLength(2);
  });

  it("times no frame before the first sample, those carry the shader compiles", async () => {
    const { host, t } = await started();
    t.frameMs = 2500;
    for (let i = 0; i < 8; i++) {
      host.tick(frame({}, 1000 + i * 16));
      await flush();
    }
    expect(t.calls.filter((c) => c.startsWith("budget:"))).toEqual(["budget:262144"]);
  });

  it("times no frame after a restart until its first sample", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(5);
    await flush();
    host.tick(frame({}, 1000, { cameraChanged: true }));
    await flush();
    t.frameMs = 2500;
    for (let i = 0; i < 8; i++) {
      host.tick(frame({}, 1100 + i * 16));
      await flush();
    }
    expect(t.calls.filter((c) => c.startsWith("budget:"))).toEqual(["budget:262144"]);
  });

  it("hands a slow GPU a smaller frame budget", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(1);
    await flush();
    t.frameMs = 30;
    for (let i = 0; i < 8; i++) {
      host.tick(frame({}, 1000 + i * 16));
      await flush();
    }
    const budgets = t.calls.filter((c) => c.startsWith("budget:")).map((c) => Number(c.slice(7)));
    expect(budgets[0]).toBe(262_144);
    expect(budgets.at(-1)).toBeLessThan(120_000);
  });

  it("traces below the canvas size", async () => {
    const { host, t } = await started();
    host.tick(frame());
    expect(t.calls).toContain("scale:0.75");
  });

  it("stops at 64 samples on battery and goes back to 256 on the charger", async () => {
    const { host, t } = await started();
    host.setPower({ discharging: true });
    host.tick(frame());
    expect(t.calls).toContain("cap:64");
    expect(t.calls).toContain("scale:0.5");
    t.answer(64);
    await flush();
    host.tick(frame());
    expect(host.state).toBe("done");
    host.setPower({ discharging: false });
    host.tick(frame());
    expect(t.calls.at(-1) === "cap:256" || t.calls.includes("cap:256")).toBe(true);
    expect(host.state).toBe("trace");
  });

  it("a traced picture holds the tracer and gives it back with a restart", async () => {
    const { host, t } = await started();
    host.tick(frame());
    t.answer(10);
    await flush();
    host.tick(frame());
    expect(host.shown).toBe(true);
    const shot = host.picture({ scale: 2, samples: 16 });
    expect(host.shown).toBe(false);
    expect(t.pictureSize).toEqual({ width: 1600, height: 1200, samples: 16 });
    t.calls.length = 0;
    host.tick(frame({}, 1100, { cameraChanged: true }));
    host.tick(frame({ mode: "realtime" }, 1200));
    expect(t.calls).toEqual([]);
    t.pictureDone!("data:image/png;base64,AAAA");
    expect(await shot).toBe("data:image/png;base64,AAAA");
    host.tick(frame());
    expect(t.calls.filter((c) => c === "reset")).toHaveLength(1);
    expect(t.calls).toContain("camera");
    expect(t.calls).toContain("sample");
  });

  it("takes no traced picture outside Path traced", async () => {
    const host = new PathTraceHost(glCanvas, async () => new FakeTracer());
    expect(await host.picture({ scale: 1, samples: 16 })).toBeNull();
  });
});
