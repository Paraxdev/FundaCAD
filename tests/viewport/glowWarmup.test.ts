import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { linkProgramsAhead } from "../../src/viewport/linkPrograms";
import { makeSelectionGlow, selectionGlowWarmup } from "../../src/viewport/selectionGlow";

// Records which materials were compiled into which target, the way three keys a program per output colour space.
function fakeRenderer(readyAfter: number) {
  const offscreenSeen: THREE.WebGLRenderTarget[] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const programs = new Map<THREE.Material, { polls: number; isReady(): boolean }>();
  const compiled: { target: string; materials: string[] }[] = [];
  const r = {
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
      if (t) offscreenSeen.push(t);
    },
    compile(obj: THREE.Object3D) {
      const mats = new Set<THREE.Material>();
      obj.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (m) mats.add(m as THREE.Material);
      });
      compiled.push({ target: target ? "offscreen" : "canvas", materials: [...mats].map((m) => m.name) });
      for (const m of mats) {
        const p = { polls: 0, isReady: () => ++p.polls > readyAfter };
        programs.set(m, p);
      }
      return mats;
    },
    properties: { get: (m: THREE.Material) => ({ currentProgram: programs.get(m) }) },
  };
  return { r: r as unknown as THREE.WebGLRenderer, compiled, offscreenSeen, current: () => target };
}

describe("the selection glow is linked ahead for both outputs", () => {
  it("carries the very materials a glow draws with, one per kind", () => {
    const geometry = new THREE.BoxGeometry(3, 1.5, 0.7).translate(12, -4, 7);
    const warm: THREE.Material[] = [];
    selectionGlowWarmup().traverse((o) => {
      if ((o as THREE.Mesh).material) warm.push((o as THREE.Mesh).material as THREE.Material);
    });
    expect(warm).toHaveLength(2);
    expect(warm[0]).toBe(makeSelectionGlow(geometry, "select").material);
    expect(warm[1]).toBe(makeSelectionGlow(geometry, "hover").material);
    expect(selectionGlowWarmup()).toBe(selectionGlowWarmup());
  });

  it("compiles the glow for the canvas and the post chain target and puts the old target back", async () => {
    const { r, compiled, current } = fakeRenderer(2);
    const before = new THREE.WebGLRenderTarget(7, 5);
    r.setRenderTarget(before);
    const offscreen = new THREE.WebGLRenderTarget(1, 1);
    const done = linkProgramsAhead(
      r,
      selectionGlowWarmup(),
      new THREE.PerspectiveCamera(),
      new THREE.Scene(),
      offscreen,
      "glow",
    );
    expect(compiled).toEqual([
      { target: "canvas", materials: ["selection-glow", "selection-glow"] },
      { target: "offscreen", materials: ["selection-glow", "selection-glow"] },
    ]);
    expect(current()).toBe(before);
    await expect(done).resolves.toBeUndefined();
  });

  it("still restores the target when a compile throws, and resolves with nothing to wait for", async () => {
    const { r, current } = fakeRenderer(0);
    const before = new THREE.WebGLRenderTarget(3, 9);
    r.setRenderTarget(before);
    (r as unknown as { compile(): never }).compile = () => {
      throw new Error("lost context");
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      const done = linkProgramsAhead(
        r,
        selectionGlowWarmup(),
        new THREE.PerspectiveCamera(),
        new THREE.Scene(),
        new THREE.WebGLRenderTarget(1, 1),
        "glow",
      );
      expect(current()).toBe(before);
      await expect(done).resolves.toBeUndefined();
    } finally {
      console.warn = warn;
    }
  });
});
