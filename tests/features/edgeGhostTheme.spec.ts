// The ghost member lines of the fillet and chamfer tools are selected edges, so they take the accent like every
// other edge pick, and follow a theme change while the tool is open.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import { EdgeFeatureTool } from "../../src/features/edgeFeatureTool";
import { oklch } from "../../src/viewport/pickColors";
import { DEFAULT_THEME_ID, setTheme } from "../../src/ui/theme";
import type { DocumentStore } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";

function lenient<T extends object>(own: Record<string, unknown>): T {
  return new Proxy(own, { get: (t, k) => (k in t ? t[k as string] : () => undefined) }) as unknown as T;
}

const EDGE = { kind: "edge", by: "nearest", point: [0, 0, 0], body: "b1" };
const near = (hex: number, to: number) => Math.abs(((oklch(hex)[2] - oklch(to)[2] + 540) % 360) - 180) < 25;

function setup() {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, -100, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const added: THREE.Object3D[] = [];
  const vp = lenient<Viewport>({
    domElement: document.createElement("canvas"),
    camera,
    suspendPicking: false,
    selectedEdgeSelectors: () => [EDGE],
    selectedEdgeScope: () => ({ scope: "single" }),
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 100, y: 100 }),
    modelDiagonal: () => 100,
    edgeLineByMid: () => null,
    edgeLineForSelector: () => ({
      points: [
        [-5, 0, 0],
        [5, 0, 0],
      ],
      body: "b1",
    }),
    visibleEdgeLines: () => [],
    addToScene: (o: THREE.Object3D) => added.push(o),
    rayFrom: () => new THREE.Raycaster(new THREE.Vector3(0, -100, 0), new THREE.Vector3(0, 1, 0)),
  });
  let n = 0;
  const store = lenient<DocumentStore>({
    document: { features: [], parameters: {} },
    nextId: () => `f${++n}`,
    onBuild: () => () => {},
    isParamBound: () => false,
    bareParamRef: () => null,
  });
  const tool = new EdgeFeatureTool(vp, store);
  tool.start("fillet", () => {});
  const ghost = () => added.find((o) => o.renderOrder === 998) as THREE.Mesh | undefined;
  return { tool, ghost };
}

describe("fillet ghost edges", () => {
  let tool: EdgeFeatureTool | null = null;
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => {
    tool?.cancel();
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
    setTheme(DEFAULT_THEME_ID);
  });

  it("take the accent and follow a theme change", () => {
    setTheme("noir-blue");
    const s = setup();
    tool = s.tool;
    const colour = () => (s.ghost()!.material as LineMaterial).color.getHex();
    expect(near(colour(), 0x3fa9f5)).toBe(true);
    setTheme("noir-red");
    expect(near(colour(), 0xff4d6d)).toBe(true);
  });
});
