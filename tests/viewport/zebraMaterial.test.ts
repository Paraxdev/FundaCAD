// The zebra material takes its stripe frame from the model box: the centre the stripe environment
// wraps, a reach about the model's radius, and a period the stripe width scales.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { fitZebraMaterial, makeZebraMaterial, releaseZebraFrame } from "../../src/viewport/overlays";
import {
  type Vec3,
  type ZebraDirection,
  ZEBRA_LAMBDA,
  ZEBRA_WIDTH_DEFAULT,
  zebraFrame,
  zebraStripeCoord,
} from "../../src/viewport/zebraStripes";
import { Viewport } from "../../src/viewport/viewport";
import { DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";

const box = () => new THREE.Box3(new THREE.Vector3(-30, -20, 0), new THREE.Vector3(30, 20, 24));
const DIAG = Math.hypot(60, 40, 24);
const val = (m: THREE.ShaderMaterial, name: string) => m.uniforms[name]!.value as unknown;
const frameOf = (m: THREE.ShaderMaterial) => ({
  centre: (val(m, "uCenter") as THREE.Vector3).toArray(),
  reach: val(m, "uReach"),
  period: val(m, "uPeriod"),
});

describe("zebraFrame", () => {
  it("centres on the box and reaches about half its radius", () => {
    const f = zebraFrame([-30, -20, 0], [30, 20, 24], 3);
    expect(f.centre).toEqual([0, 0, 12]);
    expect(f.reach).toBeCloseTo(DIAG / 4);
  });

  it("puts a few stripes on a 90 degree fillet at the default width, not a comb", () => {
    const f = zebraFrame([-30, -20, 0], [30, 20, 24], ZEBRA_WIDTH_DEFAULT);
    const r = 5;
    const u = (deg: number) => {
      const t = (deg * Math.PI) / 180;
      const n = [0, Math.sin(t), Math.cos(t)] as const;
      return zebraStripeCoord([0, r * n[1], r * n[2]], n, [0, 0, 0], "horizontal", f.reach);
    };
    const stripes = Math.abs(u(45) - u(-45)) / f.period;
    expect(stripes).toBeGreaterThan(3);
    expect(stripes).toBeLessThan(7);
  });

  it("scales the period with the width, wider stripes for a larger width", () => {
    const p = (w: number) => zebraFrame([-30, -20, 0], [30, 20, 24], w).period;
    expect(p(4)).toBeCloseTo(2 * p(2));
    expect(p(1)).toBeLessThan(p(5));
    expect(p(1)).toBeGreaterThan(0);
  });

  it("clamps the width to its steps and keeps a degenerate box finite", () => {
    const p = (w: number) => zebraFrame([0, 0, 0], [10, 10, 10], w).period;
    expect(p(0)).toBe(p(1));
    expect(p(9)).toBe(p(5));
    expect(p(Number.NaN)).toBe(p(3));
    const flat = zebraFrame([0, 0, 0], [0, 0, 0], 3);
    expect(flat.reach).toBeGreaterThan(0);
    expect(flat.period).toBeGreaterThan(0);
  });

  it("holds the frame while an edit nudges the box, so the stripes stay put", () => {
    const held = zebraFrame([-30, -20, 0], [30, 20, 24], 3);
    expect(zebraFrame([-30, -20, 0], [31, 20, 25], 3, held)).toEqual(held);
    expect(zebraFrame([-30, -20, -6], [30, 32, 24], 3, held)).toEqual(held);
    expect(zebraFrame([-29, -20, 0], [31, 20, 24], 5, held)).toEqual(zebraFrame([-30, -20, 0], [30, 20, 24], 5));
  });

  it("refits once the box grows, shrinks or moves well past the held frame", () => {
    const held = zebraFrame([-30, -20, 0], [30, 20, 24], 3);
    const fresh = (min: Vec3, max: Vec3) => expect(zebraFrame(min, max, 3, held)).toEqual(zebraFrame(min, max, 3));
    fresh([-60, -40, 0], [60, 40, 48]);
    fresh([-10, -5, 0], [10, 5, 8]);
    fresh([20, -20, 0], [80, 20, 24]);
  });
});

describe("makeZebraMaterial", () => {
  it("exposes the direction and the stripe frame as uniforms", () => {
    const mat = makeZebraMaterial();
    for (const name of ["uDirection", "uPeriod", "uReach", "uCenter"]) expect(mat.uniforms[name]).toBeDefined();
    expect(val(mat, "uDirection")).toBe(0);
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.polygonOffset).toBe(true);
  });

  it("mirrors the TS stripe constant and antialiases with fwidth", () => {
    const mat = makeZebraMaterial();
    expect(mat.fragmentShader).toContain(ZEBRA_LAMBDA.toFixed(4));
    expect(mat.fragmentShader).toContain("fwidth");
    expect(mat.fragmentShader).not.toContain("cameraPosition");
  });
});

describe("fitZebraMaterial", () => {
  it("sets the frame from the box and the direction and width from the settings", () => {
    const mat = makeZebraMaterial();
    fitZebraMaterial(mat, box(), { direction: "vertical", width: 2 });
    expect(val(mat, "uDirection")).toBe(1);
    expect((val(mat, "uCenter") as THREE.Vector3).toArray()).toEqual([0, 0, 12]);
    expect(val(mat, "uReach")).toBeCloseTo(DIAG / 4);
    const thin = val(mat, "uPeriod") as number;
    fitZebraMaterial(mat, box(), { direction: "horizontal", width: 4 });
    expect(val(mat, "uDirection")).toBe(0);
    expect(val(mat, "uPeriod")).toBeCloseTo(2 * thin);
  });

  it("leaves the frame alone for an empty box", () => {
    const mat = makeZebraMaterial();
    const before = val(mat, "uPeriod") as number;
    fitZebraMaterial(mat, new THREE.Box3(), { direction: "vertical", width: 3 });
    expect(val(mat, "uPeriod")).toBe(before);
    expect(Number.isFinite(val(mat, "uReach") as number)).toBe(true);
    expect(val(mat, "uDirection")).toBe(1);
  });

  it("keeps the stripes put when an edit nudges the box and refits when the box outgrows them", () => {
    const mat = makeZebraMaterial();
    const s = { direction: "horizontal", width: 3 } as const;
    fitZebraMaterial(mat, box(), s);
    const before = frameOf(mat);
    fitZebraMaterial(mat, new THREE.Box3(new THREE.Vector3(-30, -20, 0), new THREE.Vector3(31, 20, 25)), s);
    expect(frameOf(mat)).toEqual(before);
    const big = new THREE.Box3(new THREE.Vector3(-90, -60, 0), new THREE.Vector3(90, 60, 72));
    fitZebraMaterial(mat, big, s);
    const fresh = makeZebraMaterial();
    fitZebraMaterial(fresh, big, s);
    expect(frameOf(mat)).toEqual(frameOf(fresh));
  });

  it("fits afresh once the held frame is released, even for a box the held one would cover", () => {
    const mat = makeZebraMaterial();
    const s = { direction: "horizontal", width: 3 } as const;
    fitZebraMaterial(mat, box(), s);
    releaseZebraFrame(mat);
    const next = new THREE.Box3(new THREE.Vector3(-30, -20, 0), new THREE.Vector3(36, 24, 28));
    fitZebraMaterial(mat, next, s);
    const fresh = makeZebraMaterial();
    fitZebraMaterial(fresh, next, s);
    expect(frameOf(mat)).toEqual(frameOf(fresh));
  });
});

// The fragment shader's lines run as JS with GLSL's helpers, so they must give zebraStripeCoord's value
// for the same point, normal and frame, and a band that box filters the stripes over fwidth.
const glsl = {
  vec3: (x: number, y = x, z = x) => [x, y, z],
  dot: (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!,
  length: (a: number[]) => Math.hypot(a[0]!, a[1]!, a[2]!),
  normalize: (a: number[]) => a.map((x) => x / Math.hypot(a[0]!, a[1]!, a[2]!)),
  reflect: (i: number[], n: number[]) => i.map((x, j) => x - 2 * glsl.dot(n, i) * n[j]!),
  floor: Math.floor,
  fract: (x: number) => x - Math.floor(x),
  max: Math.max,
  mix: (x: number, y: number, t: number) => x * (1 - t) + y * t,
  smoothstep: (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  },
};

interface FragmentInputs {
  vD: Vec3;
  vN: Vec3;
  uReach: number;
  uDirection: ZebraDirection;
  uPeriod?: number;
  fwidth?: number;
}

function shaderLines(mat: THREE.ShaderMaterial, end: string, result: string) {
  const src = mat.fragmentShader;
  const main = src.lastIndexOf("void main() {");
  const helpers = src
    .slice(src.indexOf("\n", src.lastIndexOf("varying ")), main)
    .replace(/\bfloat\s+(\w+)\(float\s+(\w+)\)\s*\{/g, "function $1($2) {");
  const body = src
    .slice(main + "void main() {".length, src.indexOf(end, main))
    .replace(/\b(?:vec3|float)\s+(\w+)\s*=/g, "let $1 =");
  const args = ["fwidth", "vD", "vN", "uReach", "uDirection", "uPeriod"];
  const run = new Function(...Object.keys(glsl), ...args, `${helpers}${body}\nreturn ${result};`) as (
    ...args: unknown[]
  ) => number;
  return (i: FragmentInputs) =>
    run(
      ...Object.values(glsl),
      () => i.fwidth ?? 0,
      i.vD,
      i.vN,
      i.uReach,
      i.uDirection === "vertical" ? 1 : 0,
      i.uPeriod ?? 1,
    );
}

/** The share of [s - w / 2, s + w / 2] in the light half of a stripe, by brute force. */
function lightShare(s: number, w: number): number {
  const n = 100000;
  let lit = 0;
  for (let i = 0; i < n; i++) {
    const x = s - w / 2 + ((i + 0.5) * w) / n;
    if (x - Math.floor(x) >= 0.5) lit++;
  }
  return lit / n;
}

describe("the zebra fragment shader", () => {
  const coord = shaderLines(makeZebraMaterial(), "float s =", "u");
  const shader = (vD: Vec3, vN: Vec3, uReach: number, uDirection: ZebraDirection) =>
    coord({ vD, vN, uReach, uDirection });
  // A face square to the view with the stripe coordinate s, its stripes w wide on screen.
  const bandOf = shaderLines(makeZebraMaterial(), "vec3 col =", "band");
  const band = (s: number, w: number, vN: Vec3 = [0, 0, 1]) =>
    bandOf({ vD: [0, s, 0], vN, uReach: 18, uDirection: "horizontal", fwidth: w });

  it("computes the same stripe coordinate as zebraStripeCoord", () => {
    const cv: Vec3 = [3, -2, -40];
    const cases: { pv: Vec3; nv: Vec3 }[] = [
      { pv: [5, 7, -35], nv: [0, 0, 1] },
      { pv: [-12, 4, -48], nv: [0.3, -0.5, 0.81] },
      { pv: [8, -9, -30], nv: [-0.7, 0.2, 0.68] },
      { pv: [1, 2, -41], nv: [0.4, 0.1, -0.9] },
      { pv: [-4, 11, -52], nv: [0.99, 0, 0.01] },
    ];
    for (const direction of ["horizontal", "vertical"] as const)
      for (const { pv, nv } of cases) {
        const d: Vec3 = [pv[0] - cv[0], pv[1] - cv[1], pv[2] - cv[2]];
        expect(shader(d, nv, 18, direction)).toBeCloseTo(zebraStripeCoord(pv, nv, cv, direction, 18), 9);
      }
  });

  it("stays finite on a zero normal, as zebraStripeCoord does", () => {
    const u = shader([4, -3, 2], [0, 0, 0], 18, "horizontal");
    expect(u).toBe(zebraStripeCoord([4, -3, 2], [0, 0, 0], [0, 0, 0], "horizontal", 18));
  });

  it("box filters the stripes over a pixel, a still flat face as sharp as 1e-4 of a period", () => {
    const at = [0.25, 0.5, 0.52, 0.75, 1, -0.25, 3.49, 7.98];
    for (const w of [0, 0.05, 0.1, 0.2])
      for (const s of at) expect(band(s, w)).toBeCloseTo(lightShare(s, Math.max(w, 1e-4)), 4);
  });

  it("fades stripes under about 2 px to the mean grey instead of aliasing", () => {
    const fading = [0.2, 0.25, 0.3, 0.35, 0.4].map((w) => band(0.75, w));
    expect(fading[0]).toBeCloseTo(1, 12);
    for (let i = 1; i < fading.length; i++) expect(fading[i]! < fading[i - 1]! && fading[i]! > 0.5).toBe(true);
    expect([0.45, 0.6, 1, 4].map((w) => band(0.75, w))).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("keeps the band whole on a zero normal and at a grazing one", () => {
    const bands = [band(0.75, 0, [0, 0, 0]), band(0.25, 0, [0, 0, 0]), band(0.75, 0, [1, 0, 1e-12])];
    expect(bands.map((b) => Math.round(b * 1e9) / 1e9)).toEqual([1, 0, 1]);
  });
});

describe("the zebra view options", () => {
  // A viewport with one body and no renderer: enough for the zebra swap and the prefs sync.
  function bare() {
    const v = Object.create(Viewport.prototype) as Viewport & Record<string, unknown>;
    const mesh = new THREE.Mesh<THREE.BufferGeometry, THREE.Material>(
      new THREE.BufferGeometry(),
      new THREE.MeshStandardMaterial(),
    );
    Object.assign(v, {
      model: { box: box(), bodies: [{ id: "body1", mesh }] },
      savedMats: new Map(),
      requestRender: () => {},
    });
    return { v, mesh, sync: () => (v as unknown as { syncZebraPrefs(): void }).syncZebraPrefs() };
  }

  it("drive the shared material's direction and stripe width", () => {
    const { v, mesh, sync } = bare();
    sync();
    v.setZebra(true);
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(val(mat, "uDirection")).toBe(0);
    const before = val(mat, "uPeriod") as number;
    setRenderPref("zebraDirection", "vertical");
    setRenderPref("zebraWidth", 5);
    sync();
    expect(mesh.material).toBe(mat);
    expect(val(mat, "uDirection")).toBe(1);
    expect(val(mat, "uPeriod")).toBeCloseTo((before * 5) / 3);
    setRenderPref("zebraDirection", DEFAULT_RENDER.zebraDirection);
    setRenderPref("zebraWidth", DEFAULT_RENDER.zebraWidth);
  });

  it("are kept while zebra is off and used when it is turned on", () => {
    const { v, mesh, sync } = bare();
    setRenderPref("zebraDirection", "vertical");
    sync();
    v.setZebra(true);
    expect(val(mesh.material as THREE.ShaderMaterial, "uDirection")).toBe(1);
    setRenderPref("zebraDirection", DEFAULT_RENDER.zebraDirection);
  });

  it("keep the stripes put through a rebuild that nudges the model box", () => {
    const { v, mesh, sync } = bare();
    sync();
    v.setZebra(true);
    const mat = mesh.material as THREE.ShaderMaterial;
    const before = frameOf(mat);
    (v as unknown as { model: { box: THREE.Box3 } }).model.box.max.set(31, 20, 25);
    (v as unknown as { applyZebra(): void }).applyZebra();
    expect(frameOf(mat)).toEqual(before);
  });

  it("fit a newly opened document's own frame, not the one the last document held", () => {
    const { v, mesh, sync } = bare();
    sync();
    v.setZebra(true);
    const mat = mesh.material as THREE.ShaderMaterial;
    v.forgetZebraFrame();
    const next = new THREE.Box3(new THREE.Vector3(-30, -20, 0), new THREE.Vector3(36, 24, 28));
    (v as unknown as { model: { box: THREE.Box3 } }).model.box = next;
    (v as unknown as { applyZebra(): void }).applyZebra();
    const fresh = makeZebraMaterial();
    fitZebraMaterial(fresh, next, { direction: DEFAULT_RENDER.zebraDirection, width: DEFAULT_RENDER.zebraWidth });
    expect(frameOf(mat)).toEqual(frameOf(fresh));
  });
});
