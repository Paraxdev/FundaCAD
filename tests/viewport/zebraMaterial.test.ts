// The zebra material takes its stripe frame from the model box: the centre the stripe environment
// wraps, a reach about the model's radius, and a period the stripe width scales.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { fitZebraMaterial, makeZebraMaterial } from "../../src/viewport/overlays";
import { ZEBRA_LAMBDA, ZEBRA_WIDTH_DEFAULT, zebraFrame, zebraStripeCoord } from "../../src/viewport/zebraStripes";
import { Viewport } from "../../src/viewport/viewport";
import { DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";

const box = () => new THREE.Box3(new THREE.Vector3(-30, -20, 0), new THREE.Vector3(30, 20, 24));
const DIAG = Math.hypot(60, 40, 24);
const val = (m: THREE.ShaderMaterial, name: string) => m.uniforms[name]!.value as unknown;

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
});
