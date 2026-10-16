import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { TracerBackend } from "../../src/viewport/pathtrace/backend";
import { FIRST_SAMPLE_TIMEOUT_MS, PathTraceHost, type TraceFrame } from "../../src/viewport/pathtrace/host";
import { TRIANGLE_BUDGET } from "../../src/viewport/pathtrace/mirror";

class FakeTracer implements TracerBackend {
  readonly name = "fake";
  readonly canvas = { style: {} as Record<string, string> } as unknown as HTMLCanvasElement;
  calls: string[] = [];
  count = 0;
  pending: ((n: number) => void)[] = [];
  faultCb: ((why: string) => void) | null = null;
  async init() {}
  setSize() { this.calls.push("size"); }
  setScene() { this.calls.push("scene"); }
  updateCamera() { this.calls.push("camera"); }
  reset() { this.calls.push("reset"); }
  renderSample() { this.calls.push("sample"); }
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
    camera: new THREE.PerspectiveCamera(),
    cameraChanged: false,
    sceneMaybeChanged: false,
    root: extra.root ?? scene(),
    look: () => ({ lights: [], background: new THREE.Color(), brightness: 1, toneMapping: THREE.NeutralToneMapping, exposure: 1 }),
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
    host.tick(frame());
    host.tick(frame());
    expect(host.state).toBe("done");
    expect(t.calls).not.toContain("sample");
    expect(host.shown).toBe(true);
  });

  it("shows Realtime and spends nothing while moving or paused", async () => {
    const { host, t } = await started();
    for (const over of [{ stillMs: 10 }, { sectioned: true }, { xray: true }, { wireframe: true }, { sketchOpen: true }, { visible: false }]) {
      t.calls.length = 0;
      host.tick(frame(over));
      expect(t.calls).not.toContain("sample");
      expect(host.shown).toBe(false);
    }
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

  it("does not re-mirror on a hover, only when the scene changes", async () => {
    const root = scene();
    const { host, t } = await started();
    host.tick(frame({}, 1000, { root }));
    const scenes = () => t.calls.filter((c) => c === "scene").length;
    const before = scenes();
    host.tick(frame({}, 1000, { root, sceneMaybeChanged: true }));
    expect(scenes()).toBe(before);
    root.children[0]!.position.x = 3;
    host.tick(frame({}, 1000, { root, sceneMaybeChanged: true }));
    expect(scenes()).toBe(before + 1);
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
    expect(notes).toEqual(["Path tracing is limited to 2 million triangles for now, this model has 2.1 million"]);
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
});
