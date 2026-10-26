// A theme change has to reach the face tint, the face overlays and the edge colours without a reload.
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { Highlighter } from "../../src/viewport/highlight";
import { oklch } from "../../src/viewport/pickColors";
import { DEFAULT_THEME_ID, setTheme } from "../../src/ui/theme";
import type { EdgeRef } from "../../src/viewport/edgeLines";
import type { BodyMesh, ModelView } from "../../src/viewport/render";

function rig() {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const n = geometry.getAttribute("position").count;
  const base = new Float32Array(n * 3);
  const grey = new THREE.Color(0x9aa7b4);
  for (let i = 0; i < n; i++) base.set([grey.r, grey.g, grey.b], i * 3);
  geometry.setAttribute("color", new THREE.BufferAttribute(base.slice(), 3));
  const mesh = new THREE.Mesh(geometry);
  const tris = geometry.getIndex()!.count / 3;
  const faceIds = Array.from({ length: tris }, (_, t) => Math.floor(t / 2));
  const faceTriangles = new Map<number, number[]>();
  faceIds.forEach((f, t) => faceTriangles.set(f, [...(faceTriangles.get(f) ?? []), t]));
  const body = { id: "b1", faceStart: 0, faceCount: 6, mesh, faceIds, baseColors: base, faceTriangles };
  const painted: THREE.Color[] = [];
  const edge = {
    body: "b1",
    slot: 0,
    draw: { setColor: (_s: number, c: THREE.Color) => painted.push(c.clone()), setIdleColor: () => {} },
  } as unknown as EdgeRef;
  const view = { bodies: [body as unknown as BodyMesh] } as unknown as ModelView;
  return { view, mesh, edge, painted };
}

const hue = (c: THREE.Color) => oklch(c.getHex())[2];
const near = (h: number, to: number) => Math.abs(((h - to + 540) % 360) - 180) < 25;

describe("pick colours follow the theme", () => {
  afterEach(() => setTheme(DEFAULT_THEME_ID));

  it("repaints a selected face, its overlay and a selected edge on a theme change", async () => {
    setTheme("noir-blue");
    const { view, mesh, edge, painted } = rig();
    const h = new Highlighter(view);
    h.selectFace(0);
    h.toggleSelectEdge(edge);
    await Promise.resolve();
    const tint = () => {
      const a = mesh.geometry.getAttribute("color");
      const v = mesh.geometry.getIndex()!.getX(0);
      return new THREE.Color(a.getX(v), a.getY(v), a.getZ(v));
    };
    const overlay = () => {
      const o = mesh.children.find((c) => c.name === "face-select-overlay") as THREE.Mesh;
      const a = o.geometry.getAttribute("color");
      return new THREE.Color(a.getX(0), a.getY(0), a.getZ(0));
    };
    const blue = oklch(0x3fa9f5)[2];
    const red = oklch(0xff4d6d)[2];
    expect(near(hue(tint()), blue)).toBe(true);
    expect(near(hue(overlay()), blue)).toBe(true);
    expect(near(hue(painted.at(-1)!), blue)).toBe(true);

    setTheme("noir-red");
    expect(near(hue(tint()), red)).toBe(true);
    expect(near(hue(overlay()), red)).toBe(true);
    expect(near(hue(painted.at(-1)!), red)).toBe(true);
    h.dispose();
  });
});
