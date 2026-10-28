// The axis colours are theme tokens, so a theme change has to reach every mark drawn in them.
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { AXIS_COLOR, OriginTriad, mutedAxisColor, themedAxis } from "../../src/viewport/originTriad";
import { OriginTiles } from "../../src/viewport/originTiles";
import { DEFAULT_THEME_ID, setTheme } from "../../src/ui/theme";

const SAFE = { x: 0xe5483a, y: 0xeedf6b, z: 0x6aaef0 };

const firstColor = (o: THREE.Object3D) => {
  let hex = -1;
  o.traverse((c) => {
    const m = (c as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (hex < 0 && m?.visible && m.color) hex = m.color.getHex();
  });
  return hex;
};

describe("themed axis colours", () => {
  afterEach(() => setTheme(DEFAULT_THEME_ID));

  it("repaints the triad's arms in the new theme's axes", () => {
    const triad = new OriginTriad(new THREE.Scene());
    expect(triad.arms.map(firstColor)).toEqual(
      [AXIS_COLOR.x, AXIS_COLOR.y, AXIS_COLOR.z].map((c) => mutedAxisColor(c)),
    );
    setTheme("colorblind-safe");
    triad.applyTheme();
    expect(triad.arms.map(firstColor)).toEqual([SAFE.x, SAFE.y, SAFE.z].map((c) => mutedAxisColor(c)));
    triad.dispose();
  });

  it("fills each plane tile in its normal axis of the new theme", () => {
    const tiles = new OriginTiles(new THREE.Scene());
    setTheme("colorblind-safe");
    tiles.applyTheme(0x0b0e13);
    const fill = (k: "XY" | "XZ" | "YZ") => (tiles.planes[k].material as THREE.MeshBasicMaterial).color.getHex();
    expect([fill("XY"), fill("XZ"), fill("YZ")]).toEqual([SAFE.z, SAFE.y, SAFE.x]);
    tiles.dispose();
  });

  it("gives a gizmo axis the colour of the theme in force when it paints", () => {
    const axis = themedAxis("y", { dir: new THREE.Vector3(0, 1, 0) });
    expect(axis.color).toBe(AXIS_COLOR.y);
    setTheme("colorblind-safe");
    expect(axis.color).toBe(SAFE.y);
  });
});
