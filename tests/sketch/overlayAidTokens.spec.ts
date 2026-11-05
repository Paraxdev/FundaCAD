// The aid colours (guides, snap marker, polygon, fills, preview) follow the theme tokens, in the shared materials too.
import { afterEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  SketchOverlay,
  applySketchTheme,
  controlPolygonObjects,
  dimensionLineObjects,
  sketchAidColor,
  sketchFillColor,
  sketchPreviewColor,
  sketchSnapColor,
} from "../../src/sketch/overlay";
import { SketchPlane } from "../../src/sketch/plane";
import type { BsplineEntity } from "../../src/sketch/bsplineEdit";
import { DEFAULT_THEME_ID, setTheme, themes, type ShippedTheme } from "../../src/ui/theme";
import { invalidateThemeColors } from "../../src/viewport/themeColors";

const TOKENS = ["--sketch-aid", "--sketch-snap", "--sketch-preview", "--sketch-fill"];
const root = () => document.documentElement;
afterEach(() => {
  setTheme(DEFAULT_THEME_ID);
  for (const t of TOKENS) root().style.removeProperty(t);
  invalidateThemeColors();
  applySketchTheme();
});

function setTokens(values: Record<string, string>) {
  for (const [k, v] of Object.entries(values)) root().style.setProperty(k, v);
  invalidateThemeColors();
  applySketchTheme();
}

const plane = new SketchPlane("XY");
const spline: BsplineEntity = {
  type: "bspline",
  id: "b",
  poles: [
    { x: 3, y: 2 },
    { x: 11, y: 19 },
    { x: 26, y: -7 },
  ],
};
const colourOf = (o: THREE.Object3D) => ((o as THREE.Line).material as THREE.LineBasicMaterial).color.getHex();

interface Probe {
  guides: number;
  snap: number;
  polygon: number;
  squares: number;
  dimension: number;
  fill: number;
  hover: number;
}
function probe(): Probe {
  const o = new SketchOverlay();
  o.setGuides([[new THREE.Vector2(1, 2), new THREE.Vector2(9, 7)]], plane, 0.1);
  const guide = (o as unknown as { guideGroup: THREE.Group }).guideGroup.children[0]!;
  const snap = (o as unknown as { snapMarker: THREE.Mesh }).snapMarker;
  const group = controlPolygonObjects(spline, plane, 0.1) as THREE.Group;
  const dim = dimensionLineObjects([], plane, [[new THREE.Vector2(0, 1), new THREE.Vector2(5, 6)]]);
  const fillMat = (wr: object) =>
    (o as unknown as { fillMaterial(w: object): THREE.MeshBasicMaterial }).fillMaterial(wr);
  const wr = { sketchId: "s", region: {}, hole: false };
  const hover = { ...wr };
  (o as unknown as { hovered: object }).hovered = hover;
  return {
    guides: colourOf(guide),
    snap: (snap.material as THREE.MeshBasicMaterial).color.getHex(),
    polygon: colourOf(group.children[0]!),
    squares: colourOf(group.children[1]!),
    dimension: colourOf(dim[0]!),
    fill: fillMat({ ...wr }).color.getHex(),
    hover: fillMat(hover).color.getHex(),
  };
}

describe("sketch aid colours", () => {
  it("fall back to Noir's hex when the theme sets no token", () => {
    expect([sketchAidColor(), sketchSnapColor(), sketchPreviewColor(), sketchFillColor()]).toEqual([
      0x8fa4bd, 0xffaa33, 0xffffff, 0x3a7bd5,
    ]);
    expect(probe()).toEqual({
      guides: 0xffaa33,
      snap: 0xffaa33,
      polygon: 0x8fa4bd,
      squares: 0x8fa4bd,
      dimension: 0x8fa4bd,
      fill: 0x3a7bd5,
      hover: 0x3a7bd5,
    });
  });

  it("repaint the shared materials after a theme change, two themes in a row", () => {
    setTokens({
      "--sketch-aid": "#5a6b82",
      "--sketch-snap": "#9a4d00",
      "--sketch-preview": "#1d1b26",
      "--sketch-fill": "#1f62c9",
    });
    expect(probe()).toEqual({
      guides: 0x9a4d00,
      snap: 0x9a4d00,
      polygon: 0x5a6b82,
      squares: 0x5a6b82,
      dimension: 0x5a6b82,
      fill: 0x1f62c9,
      hover: 0x1f62c9,
    });
    expect(sketchPreviewColor()).toBe(0x1d1b26);

    setTokens({ "--sketch-snap": "#e69f00", "--sketch-aid": "#a6b4c4" });
    const second = probe();
    expect([second.guides, second.snap, second.polygon, second.dimension, second.fill]).toEqual([
      0xe69f00, 0xe69f00, 0xa6b4c4, 0xa6b4c4, 0x1f62c9,
    ]);
  });

  it("follow setTheme through to the shared materials, and back", () => {
    const hex = (id: string, t: string) =>
      parseInt((themes().find((x) => x.id === id) as ShippedTheme).palette[t]!.slice(1), 16);
    const before = probe();
    setTheme("colorblind-safe");
    const cb = probe();
    expect(cb.guides).toBe(hex("colorblind-safe", "--sketch-snap"));
    expect(cb.polygon).toBe(hex("colorblind-safe", "--sketch-aid"));
    expect(cb.fill).toBe(hex("colorblind-safe", "--sketch-fill"));
    expect(cb).not.toEqual(before);
    setTheme(DEFAULT_THEME_ID);
    expect(probe()).toEqual(before);
  });
});
