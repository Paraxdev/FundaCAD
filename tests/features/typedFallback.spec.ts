// What a floating value box reads once its text is not a number: empty hands the value back to the cursor or the
// tool, junk falls back to the last valid value TYPED (never a value the box was seeded with), and only Enter or the
// confirm button falls back, a feature switch refuses.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { DimInput } from "../../src/sketch/dimInput";
import { ModifyFlow, type ModifyHost } from "../../src/sketch/modifyFlow";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { HoleTool } from "../../src/features/holeTool";
import { closeOpenEdit } from "../../src/app/selection";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { DocumentStore, RebuildState } from "../../src/document/store";
import type { Viewport } from "../../src/viewport/viewport";
import type { Engine } from "../../src/app/engine";
import type { Feature } from "../../src/types";

const toasts = vi.hoisted(() => [] as string[]);
vi.mock("../../src/ui/toast", () => ({ toast: (m: string) => toasts.push(m) }));
vi.mock("../../src/sketch/overlay", () => ({ curveObjects: (ents: unknown[]) => ents, PREVIEW_COLOR: 0 }));
// The real solver pulls a wasm ?url that the DOM project's transform refuses, and nothing here solves.
vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

const field = (name: string) => document.querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;
function type(name: string, text: string) {
  const input = field(name);
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}
const enter = (name: string) =>
  field(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
const isBad = () => document.querySelector(".dim-input")!.classList.contains("dim-bad");
const problem = () => document.querySelector(".dim-problem")?.textContent ?? null;
const withoutId = (e: unknown) => {
  const { id: _id, ...rest } = e as { id: string };
  return rest;
};

beforeEach(() => {
  setActivePinia(createPinia());
  toasts.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("DimInput", () => {
  it("a field the cursor wrote reads null once emptied, and junk in it falls back to nothing", () => {
    const dim = new DimInput();
    const commit = vi.fn();
    dim.show([{ name: "len", label: "L" }], commit);
    dim.updateFromCursor({ len: 6.5 });
    expect(dim.getValue("len")).toBe(6.5);
    type("len", "");
    expect([dim.getValue("len"), isBad()]).toEqual([null, false]);
    type("len", "abc");
    expect([dim.getValue("len"), isBad()]).toEqual([null, true]);
    enter("len");
    expect(commit).not.toHaveBeenCalled();
    dim.dispose();
  });

  it("a seeded field that is emptied reads null, and a seeded text drops what was typed before it", () => {
    const dim = new DimInput();
    dim.show([{ name: "len", label: "L" }], () => {});
    type("len", "4.5");
    dim.seed("len", 9.25);
    type("len", "");
    expect(dim.getValue("len")).toBeNull();
    type("len", "abc");
    expect(dim.getValue("len")).toBeNull();
    type("len", "3.5");
    dim.seedText("len", "through");
    type("len", "abc");
    expect(dim.getValue("len")).toBeNull();
    dim.dispose();
  });
});

describe("sketch offset box", () => {
  const src: ResolvedEntity = { type: "line", id: "l1", x1: 0, y1: 0, x2: 10, y2: 0 };
  function startOffset() {
    const dim = new DimInput();
    const previews: unknown[][] = [];
    let entities = [src];
    const setEntities = vi.fn((l: ResolvedEntity[]) => (entities = l));
    const host = new Proxy(
      {
        entities: () => entities,
        setEntities,
        selected: () => new Set<string>(),
        dim: () => dim,
        overlay: () => ({ setPreview: (p: unknown[]) => previews.push(p) }),
        planePoint: () => new THREE.Vector2(4, 3),
        tool: () => "offset",
      } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : () => undefined) },
    ) as unknown as ModifyHost;
    const flow = new ModifyFlow(host);
    (flow as unknown as { beginOffset(i: number, a: string[]): void }).beginOffset(0, []);
    const move = () => flow.modifyHover(new MouseEvent("pointermove") as PointerEvent);
    const last = () => previews[previews.length - 1]!.map(withoutId);
    return { dim, move, last, setEntities };
  }

  it("clearing the box hands the side and distance back to the cursor", () => {
    const t = startOffset();
    t.move();
    const atCursor = t.last();
    type("offset", "-5.5");
    t.move();
    expect(t.last()).not.toEqual(atCursor);
    type("offset", "");
    t.move();
    expect(t.last()).toEqual(atCursor);
    t.dim.dispose();
  });

  it("Enter on an emptied box keeps the offset open with its toast", () => {
    const t = startOffset();
    t.move();
    type("offset", "5.5");
    type("offset", "");
    enter("offset");
    expect(toasts).toEqual(["Offset: type a distance, or Esc to cancel"]);
    expect(t.setEntities).not.toHaveBeenCalled();
    t.dim.dispose();
  });
});

describe("extrude depth box", () => {
  interface Internals {
    distance: number;
    dim: DimInput;
  }
  function startExtrude() {
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
    };
    const addFeature = vi.fn();
    const store = {
      document: { features: [{ id: "f1", type: "sketch" }] },
      buildState: { result: { mesh: { positions: [0, 0, 0] } } },
      nextId: () => "f9",
      hiddenBodyIds: () => undefined,
      addFeature,
    };
    const viewport = {
      domElement: document.createElement("canvas"),
      suspendPicking: false,
      pointInSolid: () => true,
      requestRender: vi.fn(),
      setPeek: vi.fn(),
      removeFromScene: vi.fn(),
    };
    const proto = ExtrudeTool.prototype as unknown as { updatePreview(): void; positionDim(): void };
    vi.spyOn(proto, "updatePreview").mockImplementation(() => {});
    vi.spyOn(proto, "positionDim").mockImplementation(() => {});
    const tool = new ExtrudeTool(viewport as never, overlay as never, store as never);
    tool.start(() => {});
    const t = tool as unknown as Internals;
    // A drag writes the depth and shows its size, as onMove does.
    const dragTo = (d: number) => {
      t.distance = d;
      t.dim.updateFromCursor({ distance: Math.abs(d) });
    };
    return { dragTo, addFeature };
  }
  const extrude = (distance: number) => ({
    id: "f9",
    type: "extrude",
    sketch: "f1",
    regions: [[1, 1, 0]],
    distance,
    operation: "cut",
  });

  it("a dragged cut whose box is emptied stays a cut of the dragged depth", () => {
    const r = startExtrude();
    r.dragTo(-6.5);
    type("distance", "");
    enter("distance");
    expect(r.addFeature.mock.calls.map((c) => c[0])).toEqual([extrude(-6.5)]);
  });

  it("a typed -7 then junk builds -7, sign kept", () => {
    const r = startExtrude();
    r.dragTo(3.5);
    type("distance", "-7");
    type("distance", "abc");
    expect(isBad()).toBe(true);
    enter("distance");
    expect(r.addFeature.mock.calls.map((c) => c[0])).toEqual([extrude(-7)]);
  });
});

describe("hole depth box", () => {
  function startHole() {
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("cancelAnimationFrame", () => {});
    const vp = {
      suspendPicking: false,
      domElement: document.createElement("canvas"),
      addToScene: () => {},
      removeFromScene: () => {},
      requestRender: () => {},
      pixelWorldSize: () => 0.1,
      projectToScreen: () => ({ x: 0, y: 0 }),
      clearHover: () => {},
      hoverFaceAt: () => null,
      pickFaceForPressPull: () => null,
      selectedFacesForPressPull: () => ({ faceIds: [7], bodyId: "b1" }),
      planarFace: () => ({ normal: new THREE.Vector3(0, 0, 1), origin: new THREE.Vector3(0, 0, 10) }),
      faceAreaCentroidWorld: () => new THREE.Vector3(0, 0, 10),
      modelBox: () => new THREE.Box3(new THREE.Vector3(-10, -10, 0), new THREE.Vector3(10, 10, 10)),
    } as unknown as Viewport;
    const added: Feature[] = [];
    const store = {
      nextId: () => "h1",
      setPreview: () => {},
      addFeature: (f: Feature) => added.push(f),
      verifyCommit: () => {},
      onBuild: () => () => {},
      hasPreview: false,
      previewError: null,
      buildState: { building: false } as RebuildState,
      document: { parameters: {}, features: [] },
      isParamBound: () => false,
    } as unknown as DocumentStore;
    new HoleTool(vp, store).start(() => {});
    return added;
  }
  const depthOf = (added: Feature[]) => added.map((f) => (f as unknown as { depth: number }).depth);

  it('"abc" before any typed depth refuses, marked', () => {
    const added = startHole();
    type("depth", "abc");
    enter("depth");
    expect([added, isBad(), problem()]).toEqual([[], true, 'Depth: "abc" is not a number']);
  });

  it('a typed 4 then "abc" builds depth 4, marked', () => {
    const added = startHole();
    type("depth", "4");
    type("depth", "abc");
    expect(isBad()).toBe(true);
    enter("depth");
    expect(depthOf(added)).toEqual([4]);
  });

  it("0 refuses, 0.5 builds", () => {
    const added = startHole();
    type("depth", "0");
    enter("depth");
    expect([added, problem()]).toEqual([[], "Depth must be more than 0"]);
    type("depth", "0.5");
    enter("depth");
    expect(depthOf(added)).toEqual([0.5]);
  });
});

describe("a feature switch while a value is typed", () => {
  function engine(status: string[]) {
    return {
      store: {
        isSuppressed: () => false,
        buildState: { result: null },
        document: { features: [{ id: "f1" }, { id: "f2" }] },
        rollbackIndex: 2,
        editPreviewId: "f1",
      },
      sketch: { active: false },
      toolAtWork: () => true,
      selectedFeature: "f1",
      setStatus: (m: string) => status.push(m),
      tools: {},
    } as unknown as Engine;
  }

  it("refuses junk text even with a valid value typed before it", () => {
    const dim = new DimInput();
    const commit = vi.fn();
    dim.show([{ name: "distance", label: "D" }], commit);
    type("distance", "4.5");
    type("distance", "abc");
    const status: string[] = [];
    closeOpenEdit(engine(status), "f2");
    expect([commit.mock.calls, status]).toEqual([
      [],
      ["Fix the value being typed or press Esc, then edit the other feature"],
    ]);
    enter("distance");
    expect(commit.mock.calls).toEqual([[{ distance: 4.5 }]]);
    dim.dispose();
  });
});
