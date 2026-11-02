// The key draw flow inside SketchMode: the real methods off the prototype, the real value box, a stubbed canvas.

import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

// The real solver pulls a wasm ?url that the DOM project's transform refuses, and nothing here solves.
vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));
vi.mock("../../src/ui/announce", () => ({ announce: vi.fn(), cancelAnnouncement: vi.fn() }));

import { DimInput } from "../../src/sketch/dimInput";
import { KeyDrawFlow } from "../../src/sketch/keyDrawFlow";
import { SketchMode } from "../../src/sketch/sketchMode";
import { originCandidate, type ResolvedEntity, type SnapCandidate, type SnapKind } from "../../src/sketch/snap";
import { SketchPlane } from "../../src/sketch/plane";
import type { SketchConstraint } from "../../src/types";

type Internals = {
  tool: string;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  base: THREE.Vector2 | null;
  chainStart: THREE.Vector2 | null;
  originPin: { at: THREE.Vector2; count: number } | null;
  lastCursor: THREE.Vector2;
  lastHit: { typed?: boolean } | null;
  dim: DimInput;
  keyDraw: KeyDrawFlow;
  candidates: SnapCandidate[];
  keyDrawHost(): ConstructorParameters<typeof KeyDrawFlow>[0];
  onKey(e: Partial<KeyboardEvent>): void;
  inferLine(c: THREE.Vector2): { relations: SketchConstraint[]; end: THREE.Vector2 } | null;
  placeKeyHit(h: { p: THREE.Vector2; kind: SnapKind; label?: string }): void;
};

let dim: DimInput | null = null;
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  dim?.dispose();
  dim = null;
  document.body.innerHTML = "";
});

const v = (x: number, y: number) => new THREE.Vector2(x, y);

function makeSketch(tool: string) {
  document.body.innerHTML = '<main id="main"><div id="free"></div></main>';
  dim = new DimInput();
  const calls = { setTool: [] as string[], finish: [] as boolean[] };
  const plane = new SketchPlane("XY");
  const s = Object.create(SketchMode.prototype) as Internals;
  Object.assign(s, {
    active: false,
    tool,
    entities: [],
    constraints: [],
    patterns: [],
    selected: new Set<string>(),
    splinePts: [],
    clickPts: [],
    base: null,
    baseRef: null,
    chainStart: null,
    arcStart: null,
    arcEnd: null,
    originPin: null,
    gridSnap: false,
    lastHit: null,
    lastCursor: v(13.5, -7.25),
    candidates: originCandidate(plane),
    plane,
    dim,
    dragFrom: null,
    moveDrag: null,
    patternFlow: { hasPending: () => false },
    modifyFlow: { offsetting: false, filletArmed: false, setFilletFirst() {} },
    mirrorFlow: { running: false },
    dimFlow: { picking: false, plan: null, resetDimPicks() {} },
    constraintTools: { hasPending: () => false, resetPending() {} },
    overlay: { setPreview() {} },
    inferTag: { hide() {} },
    viewport: {
      projectToScreen: () => ({ x: 300, y: 200 }),
      viewDirection: () => new THREE.Vector3(0, 0, -1),
    },
    planeMmPerPx: () => 0.5,
    commitFromCursor() {},
    setTool: (t: string) => calls.setTool.push(t),
    finish: (commit: boolean) => calls.finish.push(commit),
  });
  s.keyDraw = new KeyDrawFlow(s.keyDrawHost());
  return { s, calls };
}

const fieldEl = (name: string) => document.querySelector<HTMLInputElement>(`.dim-field[data-field="${name}"] input`)!;

function key(s: Internals, k: string, target: EventTarget | null = document.getElementById("free")) {
  let prevented = false;
  s.onKey({
    key: k,
    target,
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    preventDefault: () => (prevented = true),
    stopPropagation() {},
    get defaultPrevented() {
      return prevented;
    },
  } as Partial<KeyboardEvent>);
  return prevented;
}

function type(name: string, text: string) {
  const input = fieldEl(name);
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const fieldNames = () => [...document.querySelectorAll<HTMLElement>(".dim-field")].map((f) => f.dataset.field);

describe("a first point typed in X and Y", () => {
  it("opens the size box of the tool as a click does, and a line starts its chain there", () => {
    for (const [tool, names] of [
      ["line", ["length", "angle"]],
      ["rectangle", ["width", "height"]],
      ["circle", ["diameter"]],
    ] as const) {
      const { s } = makeSketch(tool);
      expect(key(s, "Enter")).toBe(true);
      expect(fieldNames()).toEqual(["x", "y"]);
      type("x", "25");
      type("y", "-3.5");
      fieldEl("y").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      expect(s.base).toEqual(v(25, -3.5));
      expect(s.chainStart).toEqual(tool === "line" ? v(25, -3.5) : null);
      expect(fieldNames()).toEqual(names);
      expect(s.lastCursor).toEqual(v(25, -3.5));
      expect(s.lastHit).toMatchObject({ typed: true });
      dim?.dispose();
    }
  });

  it("pins the origin when typed on it, as a click on it does", () => {
    const { s } = makeSketch("rectangle");
    key(s, "Enter");
    type("x", "0");
    type("y", "0");
    fieldEl("y").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(s.originPin).toEqual({ at: v(0, 0), count: 0 });
  });

  it("does not pin it 0.01 away", () => {
    const { s } = makeSketch("rectangle");
    key(s, "Enter");
    type("x", "0.01");
    type("y", "0");
    fieldEl("y").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(s.originPin).toBeNull();
    expect(s.base).toEqual(v(0.01, 0));
  });

  it("does not open on a plane seen edge-on", () => {
    const { s } = makeSketch("line");
    (s as unknown as { viewport: { viewDirection(): THREE.Vector3 } }).viewport.viewDirection = () =>
      new THREE.Vector3(1, 0, 0);
    expect(key(s, "Enter")).toBe(true);
    expect(dim?.isActive).toBe(false);
  });
});

describe("Escape with the X and Y box open", () => {
  it("closes the box and leaves the tool armed, then the ladder goes on as today", () => {
    const { s, calls } = makeSketch("rectangle");
    key(s, "Enter");
    expect(dim?.isActive).toBe(true);
    key(s, "Escape", fieldEl("x"));
    expect(dim?.isActive).toBe(false);
    expect(calls).toEqual({ setTool: [], finish: [] });
    key(s, "Escape");
    expect(calls).toEqual({ setTool: ["select"], finish: [] });
    s.tool = "select";
    key(s, "Escape");
    expect(calls).toEqual({ setTool: ["select"], finish: [true] });
  });

  it("drops the placed point from the size box that follows, as it does for a click", () => {
    const { s, calls } = makeSketch("circle");
    key(s, "Enter");
    type("x", "4");
    type("y", "6");
    fieldEl("y").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(s.base).toEqual(v(4, 6));
    key(s, "Escape", fieldEl("diameter"));
    expect(s.base).toBeNull();
    expect(dim?.isActive).toBe(false);
    expect(calls).toEqual({ setTool: [], finish: [] });
  });
});

describe("a typed point is exact", () => {
  const horizontalGuess = (typed: boolean) => {
    const { s } = makeSketch("line");
    s.base = v(10, 5);
    const end = v(50, 5.1);
    s.lastHit = { p: end.clone(), raw: end.clone(), kind: "free", noSnap: false, ...(typed ? { typed } : {}) } as never;
    return s.inferLine(end)?.relations.map((c) => c.type) ?? [];
  };

  it("keeps 0.1 mm of slope over 40 mm that a pointer click would pull level", () => {
    expect(horizontalGuess(false)).toContain("horizontal");
    expect(horizontalGuess(true)).not.toContain("horizontal");
  });

  it("still gets the exact horizontal when the numbers are level", () => {
    const { s } = makeSketch("line");
    s.base = v(10, 5);
    const end = v(50, 5);
    s.lastHit = { p: end.clone(), raw: end.clone(), kind: "free", typed: true } as never;
    expect(s.inferLine(end)?.relations.map((c) => c.type)).toContain("horizontal");
  });
});
