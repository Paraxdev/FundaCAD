// A value typed into a sketch tool's floating box drives the preview as it is typed and is what confirm commits,
// with no blur or pointer move in between. SketchMode's methods are the real ones off the prototype, its canvas is
// stubbed and the box is the real DimInput.

import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { SketchMode } from "../../src/sketch/sketchMode";
import { DimInput } from "../../src/sketch/dimInput";
import type { ResolvedEntity } from "../../src/sketch/snap";
import { PatternFlow, type PatternHost } from "../../src/sketch/patternFlow";
import type { SketchPattern } from "../../src/types";

// The real solver pulls a wasm ?url that the DOM project's transform refuses, and nothing here solves.
vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

type Internals = {
  tool: string;
  entities: ResolvedEntity[];
  constraints: unknown[];
  lastCursor: THREE.Vector2;
  dim: DimInput;
  base: THREE.Vector2 | null;
  polygonClick(p: THREE.Vector2): void;
  multiClickPreview(cursor: THREE.Vector2): void;
  showDimFields(): void;
  computeGeometry(a: THREE.Vector2, c: THREE.Vector2): { preview: unknown };
};

let dim: DimInput | null = null;
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  dim?.dispose();
  dim = null;
  document.body.innerHTML = "";
});

function makeSketch(tool: string) {
  dim = new DimInput();
  const previews: ResolvedEntity[][] = [];
  let renders = 0;
  const s = Object.create(SketchMode.prototype) as Internals;
  Object.assign(s, {
    tool,
    entities: [],
    constraints: [],
    patterns: [],
    clickPts: [],
    base: null,
    chainStart: null,
    lastCursor: new THREE.Vector2(),
    polygonSides: 6,
    constructionMode: false,
    dim,
    overlay: { setPreview: (p: ResolvedEntity[]) => previews.push(p) },
    entityCurve: (e: ResolvedEntity) => e,
    viewport: { requestRender: () => renders++ },
    refreshActive() {},
    requestSolve() {},
    showInfer() {},
    onState() {},
  });
  return { s, previews, lastPreview: () => previews[previews.length - 1], renders: () => renders };
}

const field = (name: string) => document.querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;

function type(name: string, text: string) {
  const input = field(name);
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function confirmButton() {
  document.querySelector(".dim-ok")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
}

function enter(name: string) {
  field(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

const isBad = () => document.querySelector(".dim-input")!.classList.contains("dim-bad");

function startPolygon() {
  const t = makeSketch("polygon");
  t.s.polygonClick(new THREE.Vector2(2.5, -1.5));
  t.s.lastCursor.set(7.5, -1.5);
  t.s.multiClickPreview(t.s.lastCursor.clone());
  return t;
}

const hexagonAt = (sides: number): Omit<Extract<ResolvedEntity, { type: "polygon" }>, "id"> => ({
  type: "polygon",
  x: 2.5,
  y: -1.5,
  radius: 5,
  sides,
  angle: 0,
});

const withoutId = (e: ResolvedEntity | undefined) => {
  const { id: _id, ...rest } = e as ResolvedEntity;
  return rest;
};

describe("polygon sides box", () => {
  it("previews the typed side count without a pointer move", () => {
    const { lastPreview, renders } = startPolygon();
    expect(lastPreview()!.map(withoutId)).toEqual([hexagonAt(6)]);
    type("sides", "8");
    expect(lastPreview()!.map(withoutId)).toEqual([hexagonAt(8)]);
    expect(renders()).toBe(1);
  });

  it("type then confirm, with no blur, builds the typed side count", () => {
    const { s } = startPolygon();
    type("sides", "8");
    confirmButton();
    expect(s.entities.map(withoutId)).toEqual([hexagonAt(8)]);
  });

  it("type then Enter builds the typed side count", () => {
    const { s } = startPolygon();
    type("sides", "5");
    enter("sides");
    expect(s.entities.map(withoutId)).toEqual([hexagonAt(5)]);
  });

  it("3 sides, the minimum, is taken", () => {
    const { s, lastPreview } = startPolygon();
    type("sides", "3");
    expect(lastPreview()!.map(withoutId)).toEqual([hexagonAt(3)]);
    expect(isBad()).toBe(false);
    confirmButton();
    expect(s.entities.map(withoutId)).toEqual([hexagonAt(3)]);
  });

  for (const bad of ["2", "", "abc", "7.5"]) {
    it(`"${bad}" keeps the last valid count, marks the box, and confirm builds that count`, () => {
      const { s, lastPreview } = startPolygon();
      type("sides", "9");
      type("sides", bad);
      expect(lastPreview()!.map(withoutId)).toEqual([hexagonAt(9)]);
      expect(isBad()).toBe(true);
      confirmButton();
      expect(s.entities.map(withoutId)).toEqual([hexagonAt(9)]);
    });
  }
});

describe("rectangle size box", () => {
  function startRectangle() {
    const t = makeSketch("rectangle");
    t.s.base = new THREE.Vector2(4, 3);
    t.s.showDimFields();
    t.s.lastCursor.set(6, 5);
    return t;
  }
  const rect = (width: number) => ({ type: "rectangle", width, height: 2, x: 4 + width / 2, y: 4 });

  it("previews the typed width without a pointer move", () => {
    const { lastPreview } = startRectangle();
    type("width", "12.5");
    expect(lastPreview()!.map(withoutId)).toEqual([rect(12.5)]);
  });

  it("type then confirm builds the typed width", () => {
    const { s } = startRectangle();
    type("width", "12.5");
    confirmButton();
    expect(s.entities.map(withoutId)).toEqual([rect(12.5)]);
  });

  it("type then Enter builds the typed width", () => {
    const { s } = startRectangle();
    type("width", "7.25");
    enter("width");
    expect(s.entities.map(withoutId)).toEqual([rect(7.25)]);
  });

  it("a width of 0 keeps the last valid one, marks the box, and confirm builds that", () => {
    const { s, lastPreview } = startRectangle();
    type("width", "7.25");
    type("width", "0");
    expect(lastPreview()!.map(withoutId)).toEqual([rect(7.25)]);
    expect(isBad()).toBe(true);
    confirmButton();
    expect(s.entities.map(withoutId)).toEqual([rect(7.25)]);
  });
});

describe("sketch bolt circle count box", () => {
  function startBoltCircle() {
    dim = new DimInput();
    const patterns: SketchPattern[] = [];
    let redraws = 0;
    const host: PatternHost = {
      tool: () => "boltCircle",
      setActiveTool() {},
      setTool() {},
      selected: () => new Set(),
      patterns: () => patterns,
      dim: () => dim!,
      sourcePoint: () => null,
      requestSolve() {},
      toScreen: () => null,
      showCentreDot() {},
      refreshActive: () => redraws++,
      onState() {},
    };
    const flow = new PatternFlow(host);
    flow.click(new THREE.Vector2(3, 2));
    return { flow, patterns, redraws: () => redraws };
  }
  const bolt = (count: number) => ({ type: "boltCircle", cx: 3, cy: 2, bcd: 40, count, diameter: 6 });
  const withoutPatternId = (p: SketchPattern | null) => {
    const { id: _id, ...rest } = p as SketchPattern;
    return rest;
  };

  it("previews the typed count without a pointer move", () => {
    const { flow, redraws } = startBoltCircle();
    const before = redraws();
    type("count", "8");
    expect(withoutPatternId(flow.pending)).toEqual(bolt(8));
    expect(redraws()).toBe(before + 1);
  });

  it("type then Enter places the typed count", () => {
    const { patterns } = startBoltCircle();
    type("count", "8");
    enter("count");
    expect(patterns.map(withoutPatternId)).toEqual([bolt(8)]);
  });

  it("type then confirm places the typed count", () => {
    const { patterns } = startBoltCircle();
    type("count", "4");
    confirmButton();
    expect(patterns.map(withoutPatternId)).toEqual([bolt(4)]);
  });

  it("a count of 0 keeps the last valid one, marks the box, and confirm places that", () => {
    const { patterns } = startBoltCircle();
    type("count", "4");
    type("count", "0");
    expect(isBad()).toBe(true);
    confirmButton();
    expect(patterns.map(withoutPatternId)).toEqual([bolt(4)]);
  });
});
