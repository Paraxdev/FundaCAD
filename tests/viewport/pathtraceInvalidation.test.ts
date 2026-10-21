import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { TracerBackend } from "../../src/viewport/pathtrace/backend";
import type { BlasBuilder, BlasJob, BlasTree } from "../../src/viewport/pathtrace/blasCache";
import { buildBlas } from "../../src/viewport/pathtrace/blasCache";
import { PathTraceHost, type TraceFrame } from "../../src/viewport/pathtrace/host";

const ENV = new THREE.Texture();
const CAMERA = new THREE.PerspectiveCamera();

class FakeTracer implements TracerBackend {
  readonly name = "fake";
  readonly canvas = { style: {} as Record<string, string> } as unknown as HTMLCanvasElement;
  maxStorageBytes = Infinity;
  calls: string[] = [];
  meshes: THREE.Mesh[] = [];
  async init() {}
  setSize() {}
  setScene(s: { meshes: THREE.Mesh[] }) { this.meshes = s.meshes; this.calls.push("scene"); }
  updateGeometry(meshes: THREE.Mesh[]) { this.meshes = meshes; this.calls.push("geometry"); }
  updateTransforms() { this.calls.push("transforms"); }
  updateMaterials() { this.calls.push("materials"); }
  updateLook() { this.calls.push("look"); }
  updateCamera() { this.calls.push("camera"); }
  reset() { this.calls.push("reset"); }
  renderSample() { return Promise.resolve(1); }
  readonly maxTextureSize = 8192;
  setFrameBudget() {}
  setRenderScale() {}
  setCap() {}
  picture() { return Promise.resolve(""); }
  readonly denoised = false;
  present() { return false; }
  setDenoise() {}
  setBloom() {}
  samples() { return new Promise<number>(() => {}); }
  dispose() { this.calls.push("dispose"); }
  onFault() {}
  work() { return this.calls.filter((c) => c !== "camera"); }
}

/** Holds every job until the test lets it finish, like a worker would. */
class HeldBuilder implements BlasBuilder {
  jobs: { job: BlasJob; done: (t: BlasTree) => void }[] = [];
  build(job: BlasJob) {
    return new Promise<BlasTree>((done) => this.jobs.push({ job, done }));
  }
  finish(i: number) {
    const j = this.jobs[i]!;
    j.done(buildBlas(j.job));
  }
  finishAll() {
    this.jobs.forEach((_, i) => this.finish(i));
  }
  dispose() {}
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const glCanvas = { clientWidth: 800, clientHeight: 600, offsetLeft: 0, offsetTop: 0, style: {}, parentElement: null } as unknown as HTMLCanvasElement;

function body(id: string, etag: string, x: number): THREE.Mesh {
  const g = new THREE.SphereGeometry(1, 8, 6);
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0x808080 }));
  m.position.x = x;
  const baseColors = new Float32Array(g.getAttribute("position").count * 3).fill(0.6);
  g.setAttribute("color", new THREE.BufferAttribute(baseColors.slice(), 3));
  m.userData.owner = { id, etag, baseColors, mesh: m };
  return m;
}

function frame(root: THREE.Object3D, over: Partial<TraceFrame["inputs"]> = {}, changed = true): TraceFrame {
  return {
    now: 1000,
    inputs: { mode: "pathtraced", visible: true, stillMs: 1000, sectioned: false, xray: false, wireframe: false, sketchOpen: false, ...over },
    camera: CAMERA,
    cameraChanged: false,
    sceneMaybeChanged: changed,
    root,
    look: () => ({ lights: [], background: new THREE.Color(), environment: ENV, brightness: 1, toneMapping: THREE.NeutralToneMapping, exposure: 1 }),
    lens: () => null,
  };
}

async function tracing() {
  const root = new THREE.Scene();
  const a = body("body1", "e1", 0);
  const b = body("body2", "e2", 3);
  root.add(a, b);
  const t = new FakeTracer();
  const builder = new HeldBuilder();
  const host = new PathTraceHost(glCanvas, async () => t, { arm: async () => {}, clear: () => {} }, builder);
  host.tick(frame(root));
  await flush();
  await flush();
  host.tick(frame(root));
  expect(t.calls).not.toContain("scene");
  builder.finishAll();
  await flush();
  host.tick(frame(root));
  expect(t.work()).toEqual(["scene", "reset"]);
  t.calls.length = 0;
  return { root, a, b, t, builder, host };
}

function replaceGeometry(m: THREE.Mesh, etag: string) {
  const g = new THREE.SphereGeometry(1.5, 10, 8);
  const baseColors = new Float32Array(g.getAttribute("position").count * 3).fill(0.6);
  m.geometry = g;
  (m.userData.owner as { etag: string; baseColors: Float32Array }).etag = etag;
  (m.userData.owner as { baseColors: Float32Array }).baseColors = baseColors;
}

const treeOf = (m: THREE.Mesh) => (m.geometry as unknown as { boundsTree?: object }).boundsTree;

describe("path tracer invalidation", () => {
  it("an edit to one body rebuilds one BLAS and keeps the other tree", async () => {
    const { root, b, t, builder, host } = await tracing();
    expect(builder.jobs).toHaveLength(2);
    const kept = t.meshes[0]!;
    const keptTree = treeOf(kept);
    expect(keptTree).toBeDefined();
    replaceGeometry(b, "e2b");
    host.tick(frame(root));
    expect(builder.jobs).toHaveLength(3);
    expect(t.work()).toEqual([]);
    expect(host.shown).toBe(false);
    builder.finish(2);
    await flush();
    host.tick(frame(root));
    expect(t.work()).toEqual(["geometry", "reset"]);
    expect(t.meshes[0]).toBe(kept);
    expect(treeOf(t.meshes[0]!)).toBe(keptTree);
    expect(treeOf(t.meshes[1]!)).toBeDefined();
    expect(t.meshes[1]!.geometry.index!.count).toBe(b.geometry.index!.count);
  });

  it("a hover resets nothing", async () => {
    const { root, a, t, builder, host } = await tracing();
    const c = a.geometry.getAttribute("color") as THREE.BufferAttribute;
    c.setXYZ(0, 1, 0.5, 0);
    c.needsUpdate = true;
    host.tick(frame(root));
    host.tick(frame(root));
    expect(t.work()).toEqual([]);
    expect(builder.jobs).toHaveLength(2);
  });

  it("a move drag does not touch the tracer, the release refits once", async () => {
    const { root, a, t, builder, host } = await tracing();
    for (let i = 1; i <= 5; i++) {
      a.position.y = i;
      a.updateMatrixWorld();
      host.tick(frame(root, { dragging: true }));
      expect(host.state).toBe("moving");
    }
    expect(t.work()).toEqual([]);
    expect(host.shown).toBe(false);
    host.tick(frame(root));
    expect(t.work()).toEqual(["transforms", "reset"]);
    expect(t.meshes[0]!.matrixWorld.elements[13]).toBe(5);
    expect(builder.jobs).toHaveLength(2);
  });

  it("a finish change only updates the materials", async () => {
    const { root, a, t, builder, host } = await tracing();
    (a.material as THREE.MeshStandardMaterial).roughness = 0.1;
    (a.material as THREE.MeshStandardMaterial).needsUpdate = true;
    host.tick(frame(root));
    expect(t.work()).toEqual(["materials", "reset"]);
    expect((t.meshes[0]!.material as THREE.MeshPhysicalMaterial).roughness).toBeCloseTo(0.1);
    expect(builder.jobs).toHaveLength(2);
  });

  it("a paint refreshes the colour copy and repacks, with no BLAS work", async () => {
    const { root, a, t, builder, host } = await tracing();
    const owner = a.userData.owner as { baseColors: Float32Array; baseVersion?: number };
    owner.baseColors.fill(0.2, 0, 3);
    owner.baseVersion = 1;
    host.tick(frame(root));
    expect(t.work()).toEqual(["geometry", "reset"]);
    expect(t.meshes[0]!.geometry.getAttribute("color").getX(0)).toBeCloseTo(0.2);
    expect(builder.jobs).toHaveLength(2);
  });

  it("hide and show rebuild the TLAS from the cached trees", async () => {
    const { root, b, t, builder, host } = await tracing();
    const tree = treeOf(t.meshes[1]!);
    b.visible = false;
    host.tick(frame(root));
    expect(t.work()).toEqual(["geometry", "reset"]);
    expect(t.meshes).toHaveLength(1);
    b.visible = true;
    host.tick(frame(root));
    expect(t.work()).toEqual(["geometry", "reset", "geometry", "reset"]);
    expect(treeOf(t.meshes[1]!)).toBe(tree);
    expect(builder.jobs).toHaveLength(2);
  });

  it("a section on and off calls nothing", async () => {
    const { root, t, host } = await tracing();
    host.tick(frame(root, { sectioned: true }));
    host.tick(frame(root, { sectioned: true }));
    host.tick(frame(root));
    expect(t.work()).toEqual([]);
  });

  it("drops a late tree from an etag that is already gone", async () => {
    const { root, b, t, builder, host } = await tracing();
    replaceGeometry(b, "e2b");
    host.tick(frame(root));
    replaceGeometry(b, "e2c");
    host.tick(frame(root));
    expect(builder.jobs).toHaveLength(4);
    builder.finish(2);
    await flush();
    host.tick(frame(root));
    expect(t.work()).toEqual([]);
    builder.finish(3);
    await flush();
    host.tick(frame(root));
    expect(t.work()).toEqual(["geometry", "reset"]);
    expect(t.meshes[1]!.geometry.index!.count).toBe(b.geometry.index!.count);
  });

  it("keeps the trees when the tracer is freed and started again", async () => {
    const { root, t, builder, host } = await tracing();
    host.dispose();
    expect(t.calls).toContain("dispose");
    host.tick(frame(root));
    await flush();
    await flush();
    host.tick(frame(root));
    expect(builder.jobs).toHaveLength(2);
  });

  it("refuses with a note when the buffers would pass what the device granted", async () => {
    const root = new THREE.Scene();
    root.add(body("body1", "e1", 0));
    const t = new FakeTracer();
    t.maxStorageBytes = 1000;
    const notes: string[] = [];
    const host = new PathTraceHost(glCanvas, async () => t, { arm: async () => {}, clear: () => {} }, new HeldBuilder());
    host.onRefuse = (why) => notes.push(why);
    host.tick(frame(root));
    await flush();
    await flush();
    host.tick(frame(root));
    host.tick(frame(root));
    expect(notes).toEqual(["Path tracing needs more GPU memory than this device allows for a model of 0.0 million triangles"]);
    expect(t.work()).toEqual([]);
  });
});
