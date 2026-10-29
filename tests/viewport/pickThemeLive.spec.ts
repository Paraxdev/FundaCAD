// What a theme change has to reach besides the highlighter: the origin triad's lit arm, and a sketch session's
// listener, which must not outlive the session.
import * as THREE from "three";
import { afterEach, describe, expect, it } from "vitest";
import { OriginTriad } from "../../src/viewport/originTriad";
import { edgeHoverColor } from "../../src/viewport/highlight";
import { DEFAULT_THEME_ID, setTheme } from "../../src/ui/theme";
import sketchSource from "../../src/sketch/sketchMode.ts?raw";

const armColor = (arm: THREE.Object3D) => {
  let hex = -1;
  arm.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
    if (hex < 0 && m?.visible && m.color) hex = m.color.getHex();
  });
  return hex;
};

describe("a theme change reaches the lit marks", () => {
  afterEach(() => setTheme(DEFAULT_THEME_ID));

  it("repaints a lit triad arm in the new hover colour", () => {
    setTheme("noir-red");
    const triad = new OriginTriad(new THREE.Scene());
    triad.highlight("Y");
    setTheme("noir-blue");
    triad.applyTheme();
    expect(armColor(triad.arms[1]!)).toBe(edgeHoverColor());
    triad.dispose();
  });

  it("a sketch session owns its theme listener", () => {
    // Registered in the constructor it stacked one listener per instance, never taken off.
    const src = sketchSource.replace(/\r\n/g, "\n");
    const from = src.indexOf("  constructor(");
    const ctor = src.slice(from, src.indexOf("\n  }\n", from));
    expect(ctor).not.toMatch(/onThemeChange/);
    expect(sketchSource).toMatch(/session\.add\(onThemeChange\(/);
  });
});
