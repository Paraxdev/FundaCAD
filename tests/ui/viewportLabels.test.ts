// Viewport label size: the stored choice and its gate, the scale it maps to, the --vp-label-scale root property the
// sketch dimension and glyph styles read, and the view cube, plane names and panel column that follow it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import browserScss from "../../src/styles/_browser.scss?raw";
import tokensScss from "../../src/styles/_tokens.scss?raw";

let stored: Map<string, string>;
let props: Map<string, string>;

function boot(entries: Record<string, string> = {}) {
  stored = new Map(Object.entries(entries));
  props = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  });
  // Vue's runtime reads createElement as it loads, through the menu module the view cube imports.
  vi.stubGlobal("document", {
    documentElement: { style: { setProperty: (k: string, v: string) => void props.set(k, v) } },
    createElement: () => ({}),
  });
}

async function load() {
  vi.resetModules();
  const prefs = await import("../../src/ui/a11yPrefs");
  const labels = await import("../../src/ui/viewportLabels");
  const cube = await import("../../src/viewport/viewCube");
  const stack = await import("../../src/ui/panelStack");
  const tiles = await import("../../src/viewport/originTiles");
  return { ...prefs, ...labels, cube, stack, tiles };
}

const KEY = "fundacad.a11y.viewportLabels";

beforeEach(() => boot());
afterEach(() => vi.unstubAllGlobals());

describe("the setting", () => {
  it("is Medium by default and takes the four sizes only", async () => {
    const m = await load();
    expect(m.a11yPrefs().viewportLabels).toBe("m");
    expect(["s", "m", "l", "xl", "XL", "medium", "", 1, null].map(m.asViewportLabels)).toEqual([
      "s",
      "m",
      "l",
      "xl",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("survives a reload, and a stored value it cannot read stays Medium", async () => {
    let m = await load();
    m.setA11yPref("viewportLabels", "xl");
    expect(stored.get(KEY)).toBe("xl");
    m = await load();
    expect(m.a11yPrefs().viewportLabels).toBe("xl");
    boot({ [KEY]: "huge" });
    m = await load();
    expect(m.a11yPrefs().viewportLabels).toBe("m");
  });

  it("maps each size to a scale that grows from Small to Extra large, Medium being today's size", async () => {
    const m = await load();
    const scales = m.VIEWPORT_LABELS.map((s) => m.VIEWPORT_LABEL_SCALE[s]);
    expect(m.VIEWPORT_LABELS).toEqual(["s", "m", "l", "xl"]);
    expect(m.VIEWPORT_LABEL_SCALE.m).toBe(1);
    expect(scales).toEqual([...scales].sort((a, b) => a - b));
    expect(new Set(scales).size).toBe(4);
  });
});

describe("the root property", () => {
  it("is set at boot from the stored choice and follows every change, Reset to defaults too", async () => {
    boot({ [KEY]: "l" });
    const m = await load();
    m.installViewportLabels();
    expect(props.get("--vp-label-scale")).toBe(String(m.VIEWPORT_LABEL_SCALE.l));
    m.setA11yPref("viewportLabels", "s");
    expect(props.get("--vp-label-scale")).toBe(String(m.VIEWPORT_LABEL_SCALE.s));
    m.resetA11yPrefs();
    expect([props.get("--vp-label-scale"), stored.has(KEY)]).toEqual(["1", false]);
  });

  it("defaults to 1 in the tokens, so a page that never installs it draws Medium labels", () => {
    expect(tokensScss).toMatch(/--vp-label-scale:\s*1;/);
  });

  it("scales the sketch dimension and glyph text but never under the 11 px floor", () => {
    const floored = "font-size: max(var(--fs-micro), calc(var(--fs-micro) * var(--vp-label-scale)))";
    for (const rule of [".sketch-dim {", ".sketch-glyph {"]) {
      const body = browserScss.slice(browserScss.indexOf(rule), browserScss.indexOf("}", browserScss.indexOf(rule)));
      expect(body, rule).toContain(floored);
    }
  });
});

describe("what follows the size", () => {
  it("grows the view cube and moves the panel column under it", async () => {
    const m = await load();
    const area = { left: 0, right: 1280, top: 40, bottom: 800 };
    const top = m.stack.stackTop(area);
    expect(m.cube.cubeSize()).toBe(m.cube.SIZE);
    m.setA11yPref("viewportLabels", "xl");
    const xl = Math.round(m.cube.SIZE * m.VIEWPORT_LABEL_SCALE.xl);
    expect(m.cube.cubeSize()).toBe(xl);
    expect(m.stack.stackTop(area) - top).toBe(xl - m.cube.SIZE);
  });

  it("grows the plane names and the box a press on a name takes", async () => {
    const m = await load();
    const t = new m.tiles.OriginTiles(new THREE.Scene());
    t.update(0.37, null, new THREE.PerspectiveCamera());
    const label = () =>
      t.planes.XY.children
        .find((c) => c.userData.role === "label")!
        .scale.toArray()
        .slice(0, 2);
    expect(label()).toEqual([m.tiles.LABEL_BOX_PX.w, m.tiles.LABEL_BOX_PX.h]);
    m.setA11yPref("viewportLabels", "l");
    t.applyLabelScale();
    const k = m.VIEWPORT_LABEL_SCALE.l;
    expect(label()).toEqual([m.tiles.LABEL_BOX_PX.w * k, m.tiles.LABEL_BOX_PX.h * k]);
    expect(t.labelBox()).toEqual({ w: m.tiles.LABEL_BOX_PX.w * k, h: m.tiles.LABEL_BOX_PX.h * k });
    t.dispose();
  });
});
