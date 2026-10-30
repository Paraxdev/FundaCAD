// A parameter expression typed into a model tool's value box binds the feature field, as a History step row does, so
// the feature follows a later change of the parameter.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { DraftTool } from "../../src/features/draftTool";
import { HoleTool } from "../../src/features/holeTool";
import { DocumentStore } from "../../src/document/store";
import type { DimInput } from "../../src/sketch/dimInput";
import type { GeometryBackend } from "../../src/geometry/client";
import type { CadDocument, Feature, RebuildReply, RebuildResult } from "../../src/types";

vi.mock("../../src/ui/toast", () => ({ toast: () => {} }));
vi.mock("../../src/sketch/overlay", () => ({ curveObjects: (ents: unknown[]) => ents, PREVIEW_COLOR: 0 }));
vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

const okReply: RebuildReply = {
  ok: true,
  result: {
    mesh: { positions: new Float32Array(0), indices: new Uint32Array(0), faceIds: new Uint32Array(0) },
    edges: [],
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  } as RebuildResult,
};
const backend = {
  rebuild: async () => okReply,
  async init() {},
  onStatus: () => () => {},
  connected: true,
} as unknown as GeometryBackend;

const ticks = () =>
  new Promise<void>((res) => {
    let i = 0;
    const tick = () => (++i > 10 ? res() : void setTimeout(tick, 0));
    tick();
  });

const field = (name: string) => document.querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;
function type(name: string, text: string) {
  const input = field(name);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const enter = (name: string) =>
  field(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

function model(extra: Partial<CadDocument> = {}): DocumentStore {
  return new DocumentStore(backend, {
    parameters: { width: 40 },
    paramDefs: { width: { expr: "40", value: 40, unit: "mm" } },
    features: [{ id: "f1", type: "sketch", plane: "XY", entities: [], constraints: [] } as unknown as Feature],
    ...extra,
  });
}

function startExtrude(real: DocumentStore, edit?: string) {
  const wr = {
    sketchId: "f1",
    interior3D: new THREE.Vector3(1, 1, 0),
    plane: {
      n: new THREE.Vector3(0, 0, 1),
      plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), 0),
      to2D: () => new THREE.Vector2(),
      to3D: () => new THREE.Vector3(),
    },
    region: { loop: [] },
  };
  const overlay = {
    regions: [],
    update: vi.fn(),
    selectedRegions: () => [wr],
    setHoverRegion: vi.fn(),
    clearRegionSelection: vi.fn(),
    selectRegionsByPoints: vi.fn(),
    regionPointsForSketch: () => [],
  };
  // The scene half of the store is faked, the document half is the real one.
  const store = {
    get document() {
      return real.document;
    },
    buildState: { result: { mesh: { positions: [0, 0, 0] } } },
    nextId: () => "f9",
    hiddenBodyIds: () => undefined,
    classifyTargetExpr: real.classifyTargetExpr.bind(real),
    boundExpr: real.boundExpr.bind(real),
    isParamBound: real.isParamBound.bind(real),
    addFeature: real.addFeature.bind(real),
    replaceFeature: real.replaceFeature.bind(real),
    beginEditPreview: vi.fn(),
    endEditPreview: vi.fn(),
  };
  const viewport = {
    domElement: document.createElement("canvas"),
    suspendPicking: false,
    pointInSolid: () => false,
    requestRender: vi.fn(),
    setPeek: vi.fn(),
    removeFromScene: vi.fn(),
  };
  const proto = ExtrudeTool.prototype as unknown as { updatePreview(): void; positionDim(): void };
  vi.spyOn(proto, "updatePreview").mockImplementation(() => {});
  vi.spyOn(proto, "positionDim").mockImplementation(() => {});
  const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
  const t = tool as unknown as { distance: number; dim: DimInput };
  if (edit) return void expect(tool.startEdit(edit, () => {})).toBe(true);
  tool.start(() => {});
  t.distance = 3;
  t.dim.updateFromCursor({ distance: 3 });
}

const depth = (s: DocumentStore) =>
  (s.document.features.find((f) => f.id === "f9") as { distance?: number } | undefined)?.distance;
const target = { kind: "feature", feature: "f9", field: "distance" } as const;

describe("the Extrude value box with parameters", () => {
  it("width / 4 builds a depth of 10 bound to the expression", () => {
    const s = model();
    startExtrude(s);
    type("distance", "width / 4");
    enter("distance");
    expect(depth(s)).toBe(10);
    expect(s.boundExpr(target)?.expr).toBe("width / 4");
  });

  it("the depth follows a later change of width", async () => {
    const s = model();
    startExtrude(s);
    type("distance", "width / 4");
    enter("distance");
    expect(s.setParamExpr("width", "60")).toBeNull();
    await ticks();
    expect(depth(s)).toBe(15);
  });

  it("rib = width / 4 makes the parameter rib that drives the depth", async () => {
    const s = model();
    startExtrude(s);
    type("distance", "rib = width / 4");
    enter("distance");
    expect(depth(s)).toBe(10);
    expect(s.boundExpr(target)).toMatchObject({ name: "rib", expr: "width / 4" });
    expect(s.setParamExpr("width", "80")).toBeNull();
    await ticks();
    expect(depth(s)).toBe(20);
  });

  it("-width / 4 keeps its sign, a cut bound to the expression", () => {
    const s = model();
    startExtrude(s);
    type("distance", "-width / 4");
    enter("distance");
    expect(depth(s)).toBe(-10);
    expect(s.boundExpr(target)?.expr).toBe("-width / 4");
  });

  it("a plain number binds nothing", () => {
    const s = model();
    startExtrude(s);
    type("distance", "12");
    enter("distance");
    expect(depth(s)).toBe(12);
    expect(s.boundExpr(target)).toBeNull();
  });

  it("an unknown name builds nothing and names it", () => {
    const s = model();
    startExtrude(s);
    type("distance", "widht / 4");
    enter("distance");
    expect(depth(s)).toBeUndefined();
    expect(document.querySelector(".dim-problem")?.textContent).toContain('"widht"');
  });

  it("an angle typed past the limit is clamped and not bound", () => {
    const s = model();
    startExtrude(s);
    type("distance", "8");
    type("taper", "width * 3");
    enter("distance");
    expect(s.boundExpr({ ...target, field: "taper" })).toBeNull();
  });
});

describe("editing an extrude in the Extrude tool", () => {
  const extruded = (paramDefs: CadDocument["paramDefs"]) =>
    model({
      paramDefs: { width: { expr: "40", value: 40, unit: "mm" }, ...paramDefs },
      features: [
        { id: "f1", type: "sketch", plane: "XY", entities: [], constraints: [] } as unknown as Feature,
        { id: "f9", type: "extrude", sketch: "f1", distance: 10, operation: "join", regions: [[1, 1, 0]] },
      ],
    });

  it("width / 2 typed in the edit binds the depth", () => {
    const s = extruded({});
    startExtrude(s, "f9");
    type("distance", "width / 2");
    enter("distance");
    expect(depth(s)).toBe(20);
    expect(s.boundExpr(target)?.expr).toBe("width / 2");
  });

  it("a depth bound to a plain number keeps its parameter with the new number", () => {
    const s = extruded({ depth: { expr: "10", value: 10, unit: "mm", target } });
    startExtrude(s, "f9");
    type("distance", "12");
    enter("distance");
    expect(depth(s)).toBe(12);
    expect(s.boundExpr(target)).toMatchObject({ name: "depth", expr: "12" });
  });
});

/** The document half of the store is the real one, the scene half answers as an idle kernel would. */
function sceneless(real: DocumentStore, id: string) {
  return {
    get document() {
      return real.document;
    },
    classifyTargetExpr: real.classifyTargetExpr.bind(real),
    boundExpr: real.boundExpr.bind(real),
    isParamBound: real.isParamBound.bind(real),
    addFeature: real.addFeature.bind(real),
    replaceFeature: real.replaceFeature.bind(real),
    nextId: () => id,
    setPreview: () => {},
    verifyCommit: () => {},
    onBuild: () => () => {},
    hasPreview: false,
    previewError: null,
    buildState: { building: false, result: null },
  } as unknown as DocumentStore;
}

function fakeViewport() {
  return {
    suspendPicking: false,
    domElement: document.createElement("canvas"),
    addToScene: () => {},
    removeFromScene: () => {},
    requestRender: () => {},
    pixelWorldSize: () => 0.1,
    projectToScreen: () => ({ x: 0, y: 0 }),
    probe: () => null,
    clearHover: () => {},
    hoverFaceAt: () => null,
    pickFaceForPressPull: () => null,
    selectedFacesForPressPull: () => ({
      selectors: [{ kind: "face", by: "nearest", point: [0, 0, 0] }],
      faceIds: [7],
      normal: new THREE.Vector3(1, 0, 0),
      anchor: new THREE.Vector3(0, 0, 5),
      bodyId: "b1",
    }),
    planarFace: () => ({ normal: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(0, 0, 10) }),
    faceAreaCentroidWorld: () => new THREE.Vector3(0, 0, 10),
    modelBox: () => new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 10)),
  } as never;
}

const solid = () =>
  model({
    features: [{ id: "f1", type: "box", width: 20, depth: 20, height: 10 } as unknown as Feature],
  });
const field_ = (s: DocumentStore, id: string, key: string) =>
  (s.document.features.find((f) => f.id === id) as Record<string, unknown> | undefined)?.[key];

describe("other model tools keep a typed parameter expression", () => {
  let frames: (() => void)[] = [];
  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (fn: () => void) => frames.push(fn));
    vi.stubGlobal("cancelAnimationFrame", () => {});
  });
  afterEach(() => vi.unstubAllGlobals());
  const flushFrame = () => frames.splice(0).forEach((f) => f());

  it("Draft binds its angle, which follows width", async () => {
    const s = solid();
    new DraftTool(fakeViewport(), sceneless(s, "p1")).start(() => {});
    type("angle", "width / 8");
    flushFrame();
    enter("angle");
    expect(field_(s, "p1", "angle")).toBe(5);
    expect(s.boundExpr({ kind: "feature", feature: "p1", field: "angle" })?.expr).toBe("width / 8");
    expect(s.setParamExpr("width", "80")).toBeNull();
    await ticks();
    expect(field_(s, "p1", "angle")).toBe(10);
  });

  it("Hole binds its depth, which follows width", async () => {
    const s = solid();
    new HoleTool(fakeViewport(), sceneless(s, "h1")).start(() => {});
    type("depth", "width / 8");
    enter("depth");
    expect(field_(s, "h1", "depth")).toBe(5);
    expect(s.boundExpr({ kind: "feature", feature: "h1", field: "depth" })?.expr).toBe("width / 8");
    expect(s.setParamExpr("width", "80")).toBeNull();
    await ticks();
    expect(field_(s, "h1", "depth")).toBe(10);
  });
});
