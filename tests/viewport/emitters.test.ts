import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  type AreaEmitter, areaEmitters, EMITTER_LUMINANCE, emitterLuminance, MAX_PATCHES_PER_BODY, minAreaRect,
} from "../../src/viewport/emitters";
import { installAreaLights } from "../../src/viewport/areaLightShadows";

/** A soup builder: every call adds one quad (two triangles) for face `fid`. */
function soup() {
  const positions: number[] = [];
  const faceIds: number[] = [];
  const quad = (fid: number, a: number[], b: number[], c: number[], d: number[]) => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    faceIds.push(fid, fid);
  };
  return { positions, faceIds, quad };
}

const all = () => true;
const near = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]!) < eps);

describe("minAreaRect", () => {
  it("finds a rotated rectangle's own sides, not an axis box around it", () => {
    const c = Math.cos(0.5), s = Math.sin(0.5);
    const pts = ([[-4, -30], [4, -30], [4, 30], [-4, 30]] as const).map(([x, y]) => [x * c - y * s + 10, x * s + y * c - 5] as [number, number]);
    const r = minAreaRect(pts)!;
    expect(r.w * r.h).toBeCloseTo(480);
    expect(near(r.center, [10, -5], 1e-9)).toBe(true);
  });
});

describe("area emitters", () => {
  it("reads an indexed mesh through its index", () => {
    // vertex 0 and 5 and 6 belong to a far away triangle on face 3; face 7 is a
    // unit square in z=5 whose corners are vertices 1..4
    const positions = [100, 100, 100, 0, 0, 5, 1, 0, 5, 1, 1, 5, 0, 1, 5, 101, 100, 100, 100, 101, 100];
    const index = [0, 5, 6, 1, 2, 3, 1, 3, 4];
    const [e] = areaEmitters(positions, index, [3, 7, 7], (f) => f === 7);
    expect(near(e!.center, [0.5, 0.5, 5])).toBe(true);
    expect(near(e!.normal, [0, 0, 1])).toBe(true);
    expect(e!.width * e!.height).toBeCloseTo(1);
  });

  it("fits a thin strip face as a thin rectangle facing out of the face", () => {
    // an 8 wide, 50 tall face in the plane x=36, facing -x
    const { positions, faceIds, quad } = soup();
    quad(1, [36, -4, 0], [36, -4, 50], [36, 4, 50], [36, 4, 0]);
    const [e] = areaEmitters(positions, null, faceIds, all);
    expect(near(e!.normal, [-1, 0, 0])).toBe(true);
    expect(near(e!.center, [36, 0, 25])).toBe(true);
    expect([e!.width, e!.height].sort((a, b) => a - b).map((v) => +v.toFixed(6))).toEqual([8, 50]);
    expect(e!.area).toBeCloseTo(400);
    expect(Math.abs(e!.xAxis[0])).toBeLessThan(1e-9); // the width lies in the face
  });

  it("gives a whole box one light per face, each on its own face", () => {
    const { positions, faceIds, quad } = soup();
    quad(0, [1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]);
    quad(1, [-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]);
    quad(2, [-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]);
    quad(3, [-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]);
    quad(4, [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]);
    quad(5, [-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]);
    const es = areaEmitters(positions, null, faceIds, all);
    expect(es).toHaveLength(6);
    for (const e of es) {
      // on the face: one unit out along its own normal
      expect(near(e.center, e.normal)).toBe(true);
      expect(e.width * e.height).toBeCloseTo(4);
    }
  });

  it("splits a curved face by facing direction, a tube lighting all round", () => {
    const { positions, faceIds, quad } = soup();
    const N = 32;
    for (let i = 0; i < N; i++) {
      const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
      quad(9, [Math.cos(a0) * 5, Math.sin(a0) * 5, 0], [Math.cos(a1) * 5, Math.sin(a1) * 5, 0],
        [Math.cos(a1) * 5, Math.sin(a1) * 5, 40], [Math.cos(a0) * 5, Math.sin(a0) * 5, 40]);
    }
    const es = areaEmitters(positions, null, faceIds, all);
    expect(es).toHaveLength(4);
    const dirs = es.map((e) => e.normal.map((v) => Math.round(v)).join(",")).sort();
    expect(dirs).toEqual(["-1,0,0", "0,-1,0", "0,1,0", "1,0,0"]);
    // in front of the curved surface, not buried inside the tube
    for (const e of es) expect(Math.hypot(e.center[0], e.center[1])).toBeGreaterThan(4.9);
  });

  it("puts a domed patch's light at its apex plane", () => {
    const positions = [-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0, 0, 0, 0.5];
    const index = [0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];
    const [e] = areaEmitters(positions, index, [1, 1, 1, 1], all);
    expect(e!.center[2]).toBeCloseTo(0.5);
  });

  it("regroups a mesh with a face per triangle into a handful of lights", () => {
    const { positions, faceIds, quad } = soup();
    for (let i = 0; i < 40; i++) quad(100 + i, [i * 3, 0, 0], [i * 3 + 1, 0, 0], [i * 3 + 1, 1, 0], [i * 3, 1, 0]);
    const es = areaEmitters(positions, null, faceIds, all);
    expect(es.length).toBeLessThanOrEqual(MAX_PATCHES_PER_BODY);
    expect(es).toHaveLength(1);
    expect(es[0]!.faces.size).toBe(40);
  });

  it("skips faces that do not glow", () => {
    const { positions, faceIds, quad } = soup();
    quad(1, [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]);
    quad(2, [0, 0, 1], [0, 1, 1], [1, 1, 1], [1, 0, 1]);
    expect(areaEmitters(positions, null, faceIds, (f) => f === 2).map((e) => e.key)).toEqual(["f2"]);
  });
});

describe("emitter luminance", () => {
  const rect = (area: number, width: number, height: number) => ({ area, width, height } as Pick<AreaEmitter, "area" | "width" | "height">);

  it("is the glow times one luminance for a face its rectangle covers", () => {
    expect(emitterLuminance(0.5, rect(12, 3, 4))).toBeCloseTo(0.5 * EMITTER_LUMINANCE);
    expect(emitterLuminance(0, rect(12, 3, 4))).toBe(0);
  });

  it("dims a disc to what its surface gives off, not its bounding square", () => {
    expect(emitterLuminance(1, rect(Math.PI, 2, 2))).toBeCloseTo(EMITTER_LUMINANCE * Math.PI / 4);
  });
});

describe("area light shadow patch", () => {
  it("installs into this three.js and unrolls into one braced copy per light", () => {
    expect(installAreaLights()).toBe(true);
    const chunk = THREE.ShaderChunk.lights_fragment_begin.replace(/NUM_RECT_AREA_LIGHTS/g, "3");
    // three's own unroll pattern (WebGLProgram.js)
    const pattern = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*i\s*\+\+\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;
    const rect = [...chunk.matchAll(pattern)].find((m) => m[3]!.includes("RE_Direct_RectArea"));
    expect(rect).toBeDefined();
    expect(rect![3]).toContain("getPointShadow");
    const body = rect![3]!.trim();
    expect(body.startsWith("{") && body.endsWith("}")).toBe(true);
  });
});
