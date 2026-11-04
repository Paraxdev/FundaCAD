// The sketch state colours are read from the theme tokens at draw time, Noir's hex when a token is missing.
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  SketchOverlay,
  curveObjects,
  sketchConflictColor,
  sketchDefinedColor,
  sketchFreeColor,
} from "../../src/sketch/overlay";
import { SketchPlane } from "../../src/sketch/plane";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { LooseEnds } from "../../src/sketch/looseEnds";
import { invalidateThemeColors } from "../../src/viewport/themeColors";

const TOKENS = [
  "--sketch-free",
  "--sketch-defined",
  "--sketch-construction",
  "--sketch-projected",
  "--sketch-projected-stale",
  "--sketch-loose-open",
  "--sketch-loose-untied",
  "--error",
];
const root = () => document.documentElement;
function setTokens(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) root().style.setProperty(k, v);
  invalidateThemeColors();
}
afterEach(() => {
  for (const t of TOKENS) root().style.removeProperty(t);
  invalidateThemeColors();
});

const plane = new SketchPlane("XY");
const SRC = { kind: "sketchCurve", sketch: "s0", entity: "e0" } as const;
const projected: ResolvedEntity = {
  type: "projected",
  id: "p1",
  source: SRC,
  curve: { kind: "line", x1: 2, y1: 1, x2: 11, y2: 7 },
};
const stale: ResolvedEntity = { ...projected, id: "p2", stale: true };
const construction: ResolvedEntity = { type: "line", id: "c1", x1: 3, y1: -2, x2: 9, y2: 6, construction: true };
const matColor = (o: THREE.Object3D): number => {
  const line = (o as THREE.Group).isGroup ? (o as THREE.Group).children[0] : o;
  return ((line as THREE.Line).material as THREE.LineBasicMaterial).color.getHex();
};
const drawn = () => curveObjects([projected, stale, construction], plane, 0x123456).map(matColor);

const ends: LooseEnds = {
  open: [
    { entity: "a", p: 0, x: 4, y: 5 },
    { entity: "b", p: 1, x: 8, y: -3 },
  ],
  untied: [{ entity: "c", p: 0, x: 12, y: 2, touches: "d", gap: 0.4, tieable: true }],
} as unknown as LooseEnds;
function looseColors(): number[] {
  const o = new SketchOverlay();
  o.setLooseEnds(plane, ends);
  const group = (o as unknown as { looseEndsGroup: THREE.Group }).looseEndsGroup;
  return group.children.map((c) => ((c as THREE.Points).material as THREE.PointsMaterial).color.getHex());
}

describe("sketch state colours", () => {
  it("fall back to Noir's hex when the theme sets no token", () => {
    expect(drawn()).toEqual([0xb07fe8, 0xd9a24d, 0xffa64d]);
    expect(looseColors()).toEqual([0xe5484d, 0xf5a524]);
    expect([sketchFreeColor(), sketchDefinedColor(), sketchConflictColor()]).toEqual([0x5b9bff, 0xffffff, 0xff5c5c]);
  });

  it("follow a token that changes, each one apart from the others", () => {
    setTokens({
      "--sketch-free": "#1f62c9",
      "--sketch-defined": "#1d1b26",
      "--sketch-construction": "#a85500",
      "--sketch-projected": "#7b3fc4",
      "--sketch-projected-stale": "#7a5a00",
      "--sketch-loose-open": "#c62828",
      "--sketch-loose-untied": "#8a5a00",
      "--error": "#841714",
    });
    expect(drawn()).toEqual([0x7b3fc4, 0x7a5a00, 0xa85500]);
    expect(looseColors()).toEqual([0xc62828, 0x8a5a00]);
    expect([sketchFreeColor(), sketchDefinedColor(), sketchConflictColor()]).toEqual([0x1f62c9, 0x1d1b26, 0x841714]);

    setTokens({ "--sketch-projected": "#f0e442", "--sketch-construction": "#e69f00" });
    expect(drawn()).toEqual([0xf0e442, 0x7a5a00, 0xe69f00]);
  });

  it("keep the old colour until the theme cache is cleared", () => {
    expect(sketchFreeColor()).toBe(0x5b9bff);
    expect(sketchDefinedColor()).toBe(0xffffff);
    root().style.setProperty("--sketch-free", "#3d8fe0");
    root().style.setProperty("--sketch-defined", "#f5f7fa");
    expect([sketchFreeColor(), sketchDefinedColor()]).toEqual([0x5b9bff, 0xffffff]);
    invalidateThemeColors();
    expect([sketchFreeColor(), sketchDefinedColor()]).toEqual([0x3d8fe0, 0xf5f7fa]);
  });
});
