// A glyph click selects its constraint and Delete removes it. The real SketchMode methods off the prototype, the real
// glyph facade and annotation store.

import { noKeyDraw, noKeySurface } from "./keyDrawStub";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { SketchMode } from "../../src/sketch/sketchMode";
import { SketchGlyphs } from "../../src/sketch/sketchGlyphs";
import { useSketchAnnotationStore } from "../../src/stores/sketchAnnotations";
import { announce } from "../../src/ui/announce";
import type { ConstraintGlyph } from "../../src/sketch/glyphs";
import type { SketchPlane } from "../../src/sketch/plane";
import type { Viewport } from "../../src/viewport/viewport";
import type { SketchConstraint } from "../../src/types";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

vi.mock("../../src/ui/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));

beforeEach(() => {
  setActivePinia(createPinia());
  vi.mocked(announce).mockClear();
});

const plane = { to3D: (x: number, y: number, out: THREE.Vector3) => out.set(x, y, 0) } as unknown as SketchPlane;
const viewport = { rig: { poseVersion: () => 0 } } as unknown as Viewport;

const ents = [
  { type: "line", id: "l1", x1: 20, y1: 3, x2: 26, y2: 5 },
  { type: "line", id: "l2", x1: 26, y1: 5, x2: 21, y2: 9 },
  { type: "line", id: "l3", x1: 21, y1: 9, x2: 40, y2: 11 },
];
const constraints = (): SketchConstraint[] => [
  { type: "vertical", line: "l1" },
  { type: "parallel", l1: "l2", l2: "l3" },
];
const glyph = (cIndex: number): ConstraintGlyph => ({ cIndex, icon: "parallel", pos: new THREE.Vector2(cIndex, 2) });

type Fake = Record<string, unknown> & {
  onKey(e: KeyboardEvent): void;
  selectConstraint(i: number): void;
  deleteConstraint(i: number): void;
};

function mode(tool = "select") {
  const log: string[] = [];
  const glyphs = new SketchGlyphs(viewport);
  const dims = { deleteSelected: vi.fn(() => false), clearSelection: vi.fn(() => log.push("dims cleared")) };
  const s = Object.create(SketchMode.prototype) as Fake;
  Object.assign(s, {
    tool,
    entities: ents,
    constraints: constraints(),
    conflictIdx: new Set<number>(),
    overIdx: new Set<number>(),
    selected: new Set(["l1", "l2"]),
    splinePts: [],
    clickPts: [],
    base: null,
    arcStart: null,
    dragFrom: null,
    moveDrag: null,
    dim: { isActive: false, ownsTarget: () => false },
    keyDraw: noKeyDraw,
    keySurface: noKeySurface,
    patternFlow: { hasPending: () => false },
    mirrorFlow: { running: false },
    modifyFlow: { offsetting: false, filletArmed: false },
    dimFlow: { picking: false, plan: null },
    constraintTools: { hasPending: () => false },
    dims,
    glyphs,
    deleteSelectedPole: () => false,
    deleteSelected: () => log.push("delete shapes"),
    setTool: (t: string) => {
      log.push(`tool ${t}`);
      s.tool = t;
      s.selected = new Set();
    },
    requestSolve: () => log.push("solve"),
    refreshActive: () => {
      log.push("refresh");
      glyphs.show([glyph(0), glyph(1)], plane, new Set(), new Set());
    },
    onState: () => log.push("state"),
    cancelGeometry() {},
    finish: () => log.push("finish"),
  });
  glyphs.onSelect = (i) => s.selectConstraint(i);
  glyphs.onDelete = (i) => {
    (s.selected as Set<string>).clear();
    s.deleteConstraint(i);
  };
  return { s, log, glyphs, dims };
}

const key = (s: Fake, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, cancelable: true });
  s.onKey(e);
  return e.defaultPrevented;
};
const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);

describe("selecting a constraint from its glyph", () => {
  it("lights its shapes, marks the glyph after the rebuild and clears a dimension selection", () => {
    const { s, log, glyphs } = mode();
    s.selectConstraint(1);
    expect([...(s.selected as Set<string>)]).toEqual(["l2", "l3"]);
    expect(useSketchAnnotationStore().glyphSelected).toBe(1);
    expect(glyphs.hasSelection()).toBe(true);
    expect(log).toEqual(["dims cleared", "refresh", "state"]);
  });

  it("arms the select tool first, since the dimension tool is live under glyphs too", () => {
    const { s, log } = mode("dimension");
    s.selectConstraint(0);
    expect(log[0]).toBe("tool select");
    expect([...(s.selected as Set<string>)]).toEqual(["l1"]);
    expect(useSketchAnnotationStore().glyphSelected).toBe(0);
  });

  it("ignores an index that is not a constraint", () => {
    const { s, log } = mode();
    s.selectConstraint(2);
    s.selectConstraint(-1);
    expect(log).toEqual([]);
    expect(useSketchAnnotationStore().glyphSelected).toBeNull();
    expect([...(s.selected as Set<string>)]).toEqual(["l1", "l2"]);
  });
});

describe("Delete with a constraint selected", () => {
  it("removes the constraint before a selected dimension or the shapes, and only once", () => {
    const { s, log, dims } = mode();
    dims.deleteSelected.mockReturnValue(true);
    s.selectConstraint(1);
    log.length = 0;
    expect(key(s, "Delete")).toBe(true);
    expect(s.constraints).toEqual([{ type: "vertical", line: "l1" }]);
    expect(dims.deleteSelected).not.toHaveBeenCalled();
    expect(log).toEqual(["solve", "refresh", "state"]);
    // the shapes the glyph lit went with the selection, so a second Delete takes nothing else
    expect((s.selected as Set<string>).size).toBe(0);
    key(s, "Backspace");
    expect(dims.deleteSelected).toHaveBeenCalledOnce();
    expect(log).not.toContain("delete shapes");
  });

  it("falls through to the dimension, then the shapes, when no glyph is selected", () => {
    const { s, log, dims } = mode();
    expect(key(s, "Delete")).toBe(true);
    expect(log).toEqual(["delete shapes"]);
    expect(s.constraints).toEqual(constraints());
    expect(dims.deleteSelected).toHaveBeenCalledOnce();
  });

  it("does not delete after a rebuild dropped the selection", () => {
    const { s, log } = mode();
    s.selectConstraint(0);
    (s.refreshActive as () => void)();
    log.length = 0;
    key(s, "Delete");
    expect(s.constraints).toEqual(constraints());
    expect(log).toEqual(["delete shapes"]);
  });

  // The badge's own editor or menu takes the Escape in between, so it never reaches SketchMode.
  it("takes the dimension badge selected after the glyph and keeps the constraint", () => {
    const { s, log, dims } = mode();
    const store = useSketchAnnotationStore();
    dims.deleteSelected.mockImplementation(() => store.dimSelected !== null);
    s.selectConstraint(1);
    store.selectDim(0);
    log.length = 0;
    expect(key(s, "Delete")).toBe(true);
    expect(s.constraints).toEqual(constraints());
    expect(dims.deleteSelected).toHaveBeenCalledOnce();
    expect(log).toEqual([]);
  });

  it("is dropped by Escape, which keeps the constraint and the sketch open", () => {
    const { s, glyphs, log } = mode();
    s.selectConstraint(0);
    (s.selected as Set<string>).clear();
    key(s, "Escape");
    expect(log).not.toContain("finish");
    expect(glyphs.hasSelection()).toBe(false);
    expect(s.constraints).toEqual(constraints());
  });
});

describe("deleting a constraint says so", () => {
  it("speaks the row name, with the state when it has one", () => {
    const { s } = mode();
    s.deleteConstraint(1);
    expect(said().at(-1)).toBe("Deleted Parallel, Line 2 and Line 3");
    s.deleteConstraint(0);
    expect(said().at(-1)).toBe("Deleted Vertical, Line 1");
    expect(s.constraints).toEqual([]);
  });

  it("speaks politely under one key, so a second delete replaces the first", () => {
    const { s } = mode();
    s.deleteConstraint(0);
    expect(vi.mocked(announce).mock.calls).toEqual([
      ["Deleted Vertical, Line 1", "polite", { key: "sketch-constraint" }],
    ]);
  });

  it("names the conflict when the constraint was flagged", () => {
    const { s } = mode();
    (s.conflictIdx as Set<number>).add(0);
    s.deleteConstraint(0);
    expect(said().at(-1)).toBe("Deleted Vertical, Line 1, conflicting");
  });

  it("says nothing for an index that is not there", () => {
    const { s } = mode();
    s.deleteConstraint(5);
    s.deleteConstraint(-1);
    expect(said()).toEqual([]);
    expect(s.constraints).toEqual(constraints());
  });
});
