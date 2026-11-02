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
vi.mock("../../src/ui/toast", () => ({ toast: vi.fn() }));

import { DimInput } from "../../src/sketch/dimInput";
import { KEY_DRAW_TOOLS, KeyDrawFlow } from "../../src/sketch/keyDrawFlow";
import { stepCoord } from "../../src/sketch/keyCursor";
import { noKeySurface } from "./keyDrawStub";
import { KeySurface } from "../../src/sketch/keySurface";
import { SketchMode } from "../../src/sketch/sketchMode";
import {
  candidatesFromEntities,
  originCandidate,
  type ResolvedEntity,
  type SnapCandidate,
  type SnapKind,
} from "../../src/sketch/snap";
import { SketchPlane } from "../../src/sketch/plane";
import { toast } from "../../src/ui/toast";
import { announce, cancelAnnouncement } from "../../src/ui/announce";
import type { SketchConstraint } from "../../src/types";

type Internals = {
  tool: string;
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  base: THREE.Vector2 | null;
  chainStart: THREE.Vector2 | null;
  originPin: { at: THREE.Vector2; count: number } | null;
  lastCursor: THREE.Vector2;
  lastHit: { p: THREE.Vector2; typed?: boolean; kind?: string } | null;
  gridSnap: boolean;
  planeMmPerPx: () => number;
  dim: DimInput;
  keyDraw: KeyDrawFlow;
  keySurface: unknown;
  candidates: SnapCandidate[];
  keyDrawHost(): ConstructorParameters<typeof KeyDrawFlow>[0];
  onKey(e: Partial<KeyboardEvent>): void;
  snapTag: unknown;
  onPointerDown(e: Partial<PointerEvent>): void;
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
  const seen = { snaps: [] as unknown[][], tags: [] as unknown[][] };
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
    overlay: {
      setPreview() {},
      setGuides() {},
      setSnapScale() {},
      setSnap: (...a: unknown[]) => seen.snaps.push(a),
    },
    snapTag: { hide() {}, show: (...a: unknown[]) => seen.tags.push(a) },
    inferTag: { hide() {}, show() {} },
    viewport: {
      projectToScreen: () => ({ x: 300, y: 200 }),
      viewDirection: () => new THREE.Vector3(0, 0, -1),
      requestRender() {},
      pixelWorldSize: () => 0.5,
    },
    planeMmPerPx: () => 0.5,
    commitFromCursor() {},
    setTool: (t: string) => calls.setTool.push(t),
    finish: (commit: boolean) => calls.finish.push(commit),
  });
  s.keySurface = noKeySurface;
  s.keyDraw = new KeyDrawFlow(s.keyDrawHost());
  return { s, calls, seen };
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

  it("opens on a digit, a minus or an @ before the tool's own key handling sees it, and a typed X goes on to the first point", async () => {
    for (const k of ["5", "-", ".", "@"]) {
      const { s } = makeSketch("line");
      expect(key(s, k), k).toBe(true);
      expect(fieldNames()).toEqual(["x", "y"]);
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      expect(fieldEl("x").value).toBe(k);
      dim?.dispose();
    }
    const { s, calls } = makeSketch("line");
    key(s, "3");
    type("x", "30");
    type("y", "12");
    fieldEl("y").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(s.base).toEqual(v(30, 12));
    expect(calls.setTool).toEqual([]);
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

const withoutId = (e: ResolvedEntity) => {
  const { id: _id, ...rest } = e;
  return rest;
};

// The real commit, with only the canvas and the solver left out.
function makeDrawing(tool: string) {
  const t = makeSketch(tool);
  const s = t.s as Internals & Record<string, unknown>;
  delete s.commitFromCursor;
  Object.assign(s, {
    constructionMode: false,
    entityCurve: (e: ResolvedEntity) => e,
    requestSolve() {},
    onState() {},
    refreshActive() {
      s.candidates = [...originCandidate(s.plane as SketchPlane), ...candidatesFromEntities(s.entities)];
    },
  });
  return t;
}

function enter(name: string) {
  fieldEl(name).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}

function typePoint(x: string, y?: string) {
  type("x", x);
  if (y !== undefined) type("y", y);
  enter("x");
}

function startAt(s: Internals, x: string, y: string) {
  key(s, "Enter");
  typePoint(x, y);
}

describe("@ as the first character of a size field", () => {
  it("turns the box into X and Y for the next point, with the @ in X", async () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    expect(fieldNames()).toEqual(["length", "angle"]);
    expect(key(s, "@", fieldEl("length"))).toBe(true);
    expect(fieldNames()).toEqual(["x", "y"]);
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    expect(fieldEl("x").value).toBe("@");
    expect(s.base).toEqual(v(7, -3));
  });

  it("does the same from the angle field, and with the field emptied again", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    type("angle", "3");
    type("angle", "");
    expect(key(s, "@", fieldEl("angle"))).toBe(true);
    expect(fieldNames()).toEqual(["x", "y"]);
  });

  it("stays text in a field that holds something, and the box is as it was", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    type("width", "5");
    expect(key(s, "@", fieldEl("width"))).toBe(false);
    expect(fieldNames()).toEqual(["width", "height"]);
  });

  it("is not taken with no point placed, where the first point's box is already X and Y", () => {
    const { s } = makeDrawing("rectangle");
    key(s, "Enter");
    expect(fieldNames()).toEqual(["x", "y"]);
    expect(key(s, "@", fieldEl("x"))).toBe(false);
  });

  it("is not taken in a tool that has no key drawing", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    s.tool = "polygon";
    expect(key(s, "@", fieldEl("length"))).toBe(false);
    expect(fieldNames()).toEqual(["length", "angle"]);
  });

  it("works with single key shortcuts off, which are for keys outside a field", async () => {
    const prefs = await import("../../src/ui/a11yPrefs");
    const spy = vi.spyOn(prefs, "singleKeysOn").mockReturnValue(false);
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    expect(key(s, "@", fieldEl("length"))).toBe(true);
    expect(fieldNames()).toEqual(["x", "y"]);
    spy.mockRestore();
  });
});

describe("the next point typed in X and Y", () => {
  it.each([
    ["@5", 12, -6],
    ["20", 20, -6],
  ])("keeps X %s when @ starts Y, and the box stays X and Y", (xText, x2, y2) => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    key(s, "@", fieldEl("length"));
    type("x", xText);
    fieldEl("y").focus();
    expect(key(s, "@", fieldEl("y"))).toBe(false);
    expect(fieldNames()).toEqual(["x", "y"]);
    expect(fieldEl("x").value).toBe(xText);
    expect(document.activeElement).toBe(fieldEl("y"));
    type("y", "@-3");
    enter("y");
    expect(s.entities.map(withoutId)).toEqual([{ type: "line", x1: 7, y1: -3, x2, y2 }]);
  });

  it("leaves @ in an emptied X to the field too, once the box is X and Y", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    key(s, "@", fieldEl("width"));
    type("x", "");
    expect(key(s, "@", fieldEl("x"))).toBe(false);
    expect(fieldNames()).toEqual(["x", "y"]);
  });

  it("draws a closed four line chain from off the origin and ends the chain on its start", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    for (const step of ["@40,0", "@0,20", "@-40,0"]) {
      key(s, "@", fieldEl("length"));
      typePoint(step);
      expect(fieldNames()).toEqual(["length", "angle"]);
    }
    expect(s.chainStart).toEqual(v(7, -3));
    key(s, "@", fieldEl("length"));
    typePoint("@0,-20");
    expect(s.entities.map(withoutId)).toEqual([
      { type: "line", x1: 7, y1: -3, x2: 47, y2: -3 },
      { type: "line", x1: 47, y1: -3, x2: 47, y2: 17 },
      { type: "line", x1: 47, y1: 17, x2: 7, y2: 17 },
      { type: "line", x1: 7, y1: 17, x2: 7, y2: -3 },
    ]);
    expect(s.base).toBeNull();
    expect(s.chainStart).toBeNull();
    expect(dim?.isActive).toBe(false);
  });

  it("closes onto the start the same when the end is typed absolute", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    key(s, "@", fieldEl("length"));
    typePoint("@40,0");
    key(s, "@", fieldEl("length"));
    typePoint("@0,20");
    key(s, "@", fieldEl("length"));
    typePoint("7", "-3");
    expect(s.entities.map(withoutId)).toEqual([
      { type: "line", x1: 7, y1: -3, x2: 47, y2: -3 },
      { type: "line", x1: 47, y1: -3, x2: 47, y2: 17 },
      { type: "line", x1: 47, y1: 17, x2: 7, y2: -3 },
    ]);
    expect(s.base).toBeNull();
    expect(s.chainStart).toBeNull();
  });

  it("draws a rectangle by its second corner in both directions", () => {
    for (const [at, entity] of [
      ["@40,20", { type: "rectangle", width: 40, height: 20, x: 27, y: 7 }],
      ["@-40,-20", { type: "rectangle", width: 40, height: 20, x: -13, y: -13 }],
    ] as const) {
      const { s } = makeDrawing("rectangle");
      startAt(s, "7", "-3");
      key(s, "@", fieldEl("width"));
      typePoint(at);
      expect(s.entities.map(withoutId)).toEqual([entity]);
      expect(s.base).toBeNull();
      expect(dim?.isActive).toBe(false);
      dim?.dispose();
    }
  });

  it("draws a circle through a typed point of its rim", () => {
    const { s } = makeDrawing("circle");
    startAt(s, "7", "-3");
    key(s, "@", fieldEl("diameter"));
    typePoint("7", "5");
    expect(s.entities.map(withoutId)).toEqual([{ type: "circle", radius: 8, x: 7, y: -3 }]);
  });

  it("refuses a second point on the first with the box still open, and Escape drops the shape", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    key(s, "@", fieldEl("width"));
    typePoint("@0,0");
    expect(s.entities).toEqual([]);
    expect(fieldNames()).toEqual(["x", "y"]);
    key(s, "Escape", fieldEl("x"));
    expect(s.base).toBeNull();
    expect(dim?.isActive).toBe(false);
  });

  it("keeps a typed width and height as driving dimensions after a first point by keys", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    type("width", "40");
    type("height", "20");
    enter("width");
    expect(s.entities.map(withoutId)).toEqual([{ type: "rectangle", width: 40, height: 20, x: 27, y: 7 }]);
    expect(s.constraints.map((c) => c.type)).toEqual(["p2pDistance", "p2pDistance"]);
  });

  it("measures from the last point of this sketch, and from 0, 0 once a new sketch is entered", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    key(s, "Escape", fieldEl("length"));
    key(s, "Enter");
    typePoint("@5,3");
    expect(s.base).toEqual(v(12, 0));
    key(s, "Escape", fieldEl("length"));
    s.keyDraw.reset();
    key(s, "Enter");
    expect(fieldEl("x").value).toBe("12");
    typePoint("@5,3");
    expect(s.base).toEqual(v(5, 3));
  });
});

describe("Enter on a size box nobody touched", () => {
  beforeEach(() => vi.mocked(toast).mockClear());

  it("opens X and Y for the next point after a point typed by keys, for each tool", () => {
    for (const [tool, first] of [
      ["line", "length"],
      ["rectangle", "width"],
      ["circle", "diameter"],
    ] as const) {
      const { s } = makeDrawing(tool);
      startAt(s, "7", "-3");
      expect(fieldNames()).not.toEqual(["x", "y"]);
      enter(first);
      expect(fieldNames(), tool).toEqual(["x", "y"]);
      expect([fieldEl("x").value, fieldEl("y").value]).toEqual(["7", "-3"]);
      expect(toast).not.toHaveBeenCalled();
      expect(s.entities).toEqual([]);
      dim?.dispose();
    }
  });

  it("does the same with focus on nothing in the box, and a chain goes on the same way", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    key(s, "Enter");
    expect(fieldNames()).toEqual(["x", "y"]);
    typePoint("@40,5");
    expect(s.entities.map(withoutId)).toEqual([{ type: "line", x1: 7, y1: -3, x2: 47, y2: 2 }]);
    enter("length");
    expect(fieldNames()).toEqual(["x", "y"]);
    expect([fieldEl("x").value, fieldEl("y").value]).toEqual(["47", "2"]);
  });

  it("says it needs a size when the first point was a click", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    s.keyDraw.pointerPressed();
    enter("length");
    expect(fieldNames()).toEqual(["length", "angle"]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(toast).mock.calls[0]![0]).toMatch(/size/);
    expect(vi.mocked(toast).mock.calls[0]![0]).not.toMatch(/click/i);
  });

  it("forgets the keys when the canvas takes a left press, and not for a right one", () => {
    const { s } = makeDrawing("line");
    Object.assign(s, { dims: { clearSelection() {} }, snapAt: () => null, rightDownAt: null, rightDragged: false });
    startAt(s, "7", "-3");
    s.onPointerDown({ button: 2, clientX: 1, clientY: 1 });
    enter("length");
    expect(fieldNames()).toEqual(["x", "y"]);
    startAt(s, "9", "4");
    s.onPointerDown({ button: 0, clientX: 1, clientY: 1 });
    enter("length");
    expect(fieldNames()).toEqual(["length", "angle"]);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it("is a refusal when something was typed, even if it is 0, or the angle alone", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    type("length", "0");
    enter("length");
    expect(fieldNames()).toEqual(["length", "angle"]);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(s.entities).toEqual([]);
    dim?.dispose();
    const other = makeDrawing("line");
    startAt(other.s, "7", "-3");
    type("angle", "30");
    enter("angle");
    expect(fieldNames()).toEqual(["length", "angle"]);
    expect(toast).toHaveBeenCalledTimes(2);
    expect(other.s.entities).toEqual([]);
  });

  it("commits at the cursor once it has left the point", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    s.lastCursor.set(30, 5);
    enter("length");
    expect(s.entities.map(withoutId)).toEqual([{ type: "line", x1: 7, y1: -3, x2: 30, y2: 5 }]);
    expect(toast).not.toHaveBeenCalled();
  });

  it("starts again from a keys point after a click, and keeps nothing from the first sketch", () => {
    const first = makeDrawing("line");
    startAt(first.s, "7", "-3");
    first.s.keyDraw.pointerPressed();
    dim?.dispose();
    const { s } = makeDrawing("rectangle");
    startAt(s, "2", "9");
    enter("width");
    expect(fieldNames()).toEqual(["x", "y"]);
  });
});

describe("a shape the size box's Enter finished at the cursor", () => {
  const line: ResolvedEntity = { type: "line", id: "l1", x1: 60, y1: 10, x2: 100, y2: 50 };
  const withLine = (tool: string) => {
    const r = makeDrawing(tool);
    r.s.entities = [line];
    r.s.candidates = [...candidatesFromEntities([line]), ...originCandidate(new SketchPlane("XY"))];
    return r;
  };
  const arrows = (s: Internals, field: string, ...keys: string[]) => keys.forEach((k) => key(s, k, fieldEl(field)));

  it("measures the next @ from that corner, so a new rectangle starts from it", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    arrows(s, "width", "ArrowRight", "ArrowUp");
    const end = s.lastCursor.clone();
    enter("width");
    expect(s.entities).toHaveLength(1);
    expect(key(s, "Enter")).toBe(true);
    expect(fieldNames()).toEqual(["x", "y"]);
    expect(s.entities).toHaveLength(1);
    typePoint("@5,3");
    expect(s.base).toEqual(v(end.x + 5, end.y + 3));
  });

  it("gives Enter back to opening X and Y, for a line's next point too", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    arrows(s, "length", "ArrowRight", "ArrowUp");
    enter("length");
    expect(s.entities).toHaveLength(1);
    enter("length");
    expect(fieldNames()).toEqual(["x", "y"]);
    expect(s.entities).toHaveLength(1);
  });

  it("drops Tab's walk, and the next walk holds the new line's snaps", () => {
    const { s } = withLine("line");
    startAt(s, "7", "-3");
    arrows(s, "length", "ArrowRight", "Tab");
    const end = s.lastCursor.clone();
    enter("length");
    expect(key(s, "Tab", fieldEl("length"))).toBe(false);
    arrows(s, "length", "ArrowRight");
    const seen = Array.from({ length: 6 }, () => {
      key(s, "Tab", fieldEl("length"));
      return [s.lastCursor.x, s.lastCursor.y];
    });
    expect(seen).toContainEqual([(7 + end.x) / 2, (-3 + end.y) / 2]);
    expect(seen).not.toContainEqual([end.x, end.y]);
  });

  it("cancels the cursor sentence still waiting, and a box that refused keeps it", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    arrows(s, "width", "ArrowRight");
    vi.mocked(cancelAnnouncement).mockClear();
    s.lastCursor.set(7, 12);
    enter("width");
    expect(s.entities).toEqual([]);
    expect(cancelAnnouncement).not.toHaveBeenCalled();
    arrows(s, "width", "ArrowRight");
    enter("width");
    expect(s.entities).toHaveLength(1);
    expect(cancelAnnouncement).toHaveBeenCalledWith("sketch-cursor");
  });

  it("clears the same state when a size was typed, and the corner stays where the size put it", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    arrows(s, "width", "ArrowRight");
    const cursor = s.lastCursor.clone();
    vi.mocked(cancelAnnouncement).mockClear();
    type("width", "30");
    type("height", "12");
    enter("width");
    expect(s.entities.map(withoutId)).toEqual([{ type: "rectangle", x: 22, y: 3, width: 30, height: 12 }]);
    expect(cancelAnnouncement).toHaveBeenCalledWith("sketch-cursor");
    expect(s.lastCursor).toEqual(cursor);
    expect(key(s, "Enter")).toBe(true);
    expect(fieldNames()).toEqual(["x", "y"]);
    typePoint("@1,2");
    expect(s.base).toEqual(v(8, -1));
  });

  it("opens X and Y next also when a click placed the first point and keys the second", () => {
    const { s } = makeDrawing("line");
    s.base = v(7, -3);
    s.keyDraw.placed(v(7, -3));
    (s as never as { showDimFields(): void }).showDimFields();
    arrows(s, "length", "ArrowRight", "ArrowUp");
    enter("length");
    expect(s.entities).toHaveLength(1);
    enter("length");
    expect(fieldNames()).toEqual(["x", "y"]);
  });
});

describe("a chain's next point after a typed length and angle", () => {
  const endX = 5 + 40 * Math.cos(Math.PI / 6);
  const typedLine = () => {
    const r = makeDrawing("line");
    startAt(r.s, "5", "-7");
    type("length", "40");
    type("angle", "30");
    enter("length");
    return r;
  };

  it("stands the cursor on the line's end, so Enter opens X and Y there and draws nothing", () => {
    const { s } = typedLine();
    expect(s.base!.x).toBeCloseTo(endX, 9);
    expect(s.base!.y).toBeCloseTo(13, 9);
    expect(s.lastCursor).toEqual(s.base);
    enter("length");
    expect(fieldNames()).toEqual(["x", "y"]);
    expect([fieldEl("x").value, fieldEl("y").value]).toEqual(["39.64", "13"]);
    expect(s.entities).toHaveLength(1);
    expect(s.chainStart).toEqual(v(5, -7));
  });

  it("steps an arrow from the line's end", () => {
    const { s } = typedLine();
    const base = s.base!.clone();
    key(s, "ArrowRight", fieldEl("length"));
    expect(s.lastCursor).toEqual(v(stepCoord(base.x, s.keyDrawHost().step(), 1), base.y));
  });

  it("measures @ from the line's end once the chain was dropped", () => {
    const { s } = typedLine();
    (s as never as { cancelGeometry(): void }).cancelGeometry();
    key(s, "Enter");
    typePoint("@1,2");
    expect(s.base!.x).toBeCloseTo(endX + 1, 9);
    expect(s.base!.y).toBeCloseTo(15, 9);
  });

  it("leaves the cursor to the pointer when a click placed the point", () => {
    const { s } = makeDrawing("line");
    s.base = v(5, -7);
    s.keyDraw.placed(v(5, -7));
    (s as never as { showDimFields(): void }).showDimFields();
    s.lastCursor.set(20, 9);
    type("length", "40");
    enter("length");
    expect(s.entities).toHaveLength(1);
    expect(s.lastCursor).toEqual(v(20, 9));
  });
});

describe("a second point the size box's Enter places on the origin", () => {
  it.each(["rectangle", "line"])("pins the %s's end there, as a click does", (tool) => {
    const { s } = makeDrawing(tool);
    startAt(s, "7", "-3");
    const first = tool === "line" ? "length" : "width";
    key(s, "ArrowRight", fieldEl(first));
    key(s, "Tab", fieldEl(first));
    expect(s.lastCursor).toEqual(v(0, 0));
    enter(first);
    expect(s.entities).toHaveLength(1);
    expect(s.originPin).toEqual({ at: v(0, 0), count: 0 });
    expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toContain("snapped to the origin");
  });

  it("does not pin when a size was typed, since the end is then not the origin", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    key(s, "ArrowRight", fieldEl("width"));
    key(s, "Tab", fieldEl("width"));
    type("width", "30");
    enter("width");
    expect(s.entities).toHaveLength(1);
    expect(s.originPin).toBeNull();
  });

  it("does not pin a cursor an arrow left off the origin, nor a cursor no key moved", () => {
    const a = makeDrawing("rectangle").s;
    startAt(a, "7", "-3");
    key(a, "ArrowRight", fieldEl("width"));
    key(a, "ArrowUp", fieldEl("width"));
    enter("width");
    expect(a.entities).toHaveLength(1);
    expect(a.originPin).toBeNull();
    dim?.dispose();

    const b = makeDrawing("rectangle").s;
    b.base = v(7, -3);
    b.keyDraw.placed(v(7, -3));
    (b as never as { showDimFields(): void }).showDimFields();
    b.lastCursor.set(0, 0);
    enter("width");
    expect(b.entities).toHaveLength(1);
    expect(b.originPin).toBeNull();
  });
});

describe("a size the box refuses", () => {
  const assertive = () => vi.mocked(announce).mock.calls.filter((c) => c[1] === "assertive").map((c) => c[0]);
  beforeEach(() => vi.mocked(announce).mockClear());

  it.each([
    ["rectangle", "height", "0", "must be more than 0"],
    ["rectangle", "width", "-3", "must be more than 0"],
    ["rectangle", "width", "abc", "is not a number"],
    ["circle", "diameter", "0", "must be more than 0"],
    ["circle", "diameter", "-6", "must be more than 0"],
    ["line", "length", "abc", "is not a number"],
    ["line", "angle", "abc", "is not a number"],
  ])("speaks it for %s %s %s, draws nothing and stays on the field", (tool, name, text, words) => {
    const { s } = makeDrawing(tool);
    startAt(s, "7", "-3");
    type(name, text);
    enter(name);
    expect(s.entities).toEqual([]);
    expect(assertive()).toHaveLength(1);
    expect(assertive()[0]).toContain(words);
    expect(document.activeElement).toBe(fieldEl(name));
    expect(fieldEl(name).getAttribute("aria-invalid")).toBe("true");
  });

  it("says nothing assertive for a size it takes, nor for text that falls back on the last good value", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    type("width", "30");
    type("height", "12");
    type("width", "abc");
    enter("height");
    expect(s.entities.map(withoutId)).toEqual([{ type: "rectangle", x: 22, y: 3, width: 30, height: 12 }]);
    expect(assertive()).toEqual([]);
  });
});

describe("a second point that makes no shape", () => {
  const calls = () => vi.mocked(announce).mock.calls;
  beforeEach(() => vi.mocked(announce).mockClear());

  it.each([
    ["line", "@0,0"],
    ["rectangle", "@5,0"],
    ["rectangle", "7"],
    ["circle", "@0,0"],
  ])("refuses %s at %s out loud, marks the box and says no point", (tool, text) => {
    const { s } = makeDrawing(tool);
    startAt(s, "7", "-3");
    const size = tool === "line" ? "length" : tool === "rectangle" ? "width" : "diameter";
    key(s, "@", fieldEl(size));
    vi.mocked(announce).mockClear();
    typePoint(text);
    expect(s.entities).toEqual([]);
    expect(s.base).toEqual(v(7, -3));
    expect(calls()).toHaveLength(1);
    expect(calls()[0]![1]).toBe("assertive");
    expect(calls()[0]![0]).toContain("Too small");
    expect(fieldNames()).toEqual(["x", "y"]);
    expect(fieldEl("x").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(fieldEl("x"));
  });

  it("does the same for Enter on a cursor walked back onto the first point", () => {
    const { s } = makeDrawing("line");
    s.gridSnap = false;
    key(s, "ArrowRight");
    const first = s.lastCursor.clone();
    key(s, "Enter");
    expect(s.base).toEqual(first);
    const size = fieldEl("length");
    key(s, "ArrowRight", size);
    key(s, "ArrowLeft", size);
    expect(s.lastCursor).toEqual(first);
    vi.mocked(announce).mockClear();
    key(s, "Enter");
    expect(s.entities).toEqual([]);
    expect(calls().map((c) => c[1])).toEqual(["assertive"]);
  });

  it("speaks the point as before when the next point does make a shape", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    key(s, "@", fieldEl("length"));
    vi.mocked(announce).mockClear();
    typePoint("@5,-1");
    expect(s.entities).toHaveLength(1);
    expect(calls().map((c) => c[1])).toEqual(["polite"]);
  });
});

describe("what a keys drawing says", () => {
  beforeEach(() => vi.mocked(announce).mockClear());
  const said = () => vi.mocked(announce).mock.calls.map((c) => c[0]);

  it("says the point with the line it finished, and that the last one closed the loop", () => {
    const { s } = makeDrawing("line");
    startAt(s, "7", "-3");
    for (const step of ["@40,0", "@0,20", "@-40,0"]) {
      key(s, "@", fieldEl("length"));
      typePoint(step);
    }
    expect(said()).toEqual([
      "Point at 7, minus 3",
      "Point at 47, minus 3. Line 1, length 40",
      "Point at 47, 17. Line 2, length 20",
      "Point at 7, 17. Line 3, length 40",
    ]);
    key(s, "@", fieldEl("length"));
    typePoint("@0,-20");
    expect(said().at(-1)).toBe("Point at 7, minus 3, snapped to the start of Line 1. Line 4, length 20, loop closed");
  });

  it("says a rectangle and a circle sized in the box, whichever way the first point came", () => {
    const rect = makeDrawing("rectangle");
    startAt(rect.s, "7", "-3");
    rect.s.keyDraw.pointerPressed();
    type("width", "40");
    type("height", "20");
    enter("width");
    expect(said().at(-1)).toBe("Rectangle 1, 40 by 20");
    dim?.dispose();
    const circ = makeDrawing("circle");
    startAt(circ.s, "7", "-3");
    type("diameter", "10");
    enter("diameter");
    expect(said().at(-1)).toBe("Circle 1, diameter 10");
  });

  it("says the end Tab picked when the size box's Enter draws to it, and not when a size was typed", () => {
    const { s } = makeDrawing("line");
    s.entities = [{ type: "line", id: "l1", x1: 60, y1: 10, x2: 100, y2: 50 }];
    (s as unknown as { refreshActive(): void }).refreshActive();
    startAt(s, "7", "-3");
    vi.mocked(announce).mockClear();
    key(s, "ArrowRight", fieldEl("length"));
    key(s, "Tab", fieldEl("length"));
    key(s, "Tab", fieldEl("length"));
    expect(s.lastCursor).toEqual(v(60, 10));
    enter("length");
    expect(said().at(-1)).toBe("Point at 60, 10, snapped to the start of Line 1. Line 2, length 54.571");
    expect(s.entities.map(withoutId).at(-1)).toEqual({ type: "line", x1: 7, y1: -3, x2: 60, y2: 10 });
    key(s, "ArrowRight", fieldEl("length"));
    type("length", "25");
    enter("length");
    expect(said().at(-1)).toMatch(/^Line 3, length 25$/);
  });

  it("stays silent for a click that finishes a shape", () => {
    const { s } = makeDrawing("rectangle");
    startAt(s, "7", "-3");
    vi.mocked(announce).mockClear();
    (s as unknown as { commitFromCursor(c: THREE.Vector2): unknown }).commitFromCursor(v(30, 9));
    expect(s.entities.length).toBe(1);
    expect(said()).toEqual([]);
  });
});

describe("focus and prompt in the sketch", () => {
  function keysSketch(tool: string) {
    const { s, calls } = makeDrawing(tool);
    const surfaceModel = new KeySurface();
    surfaceModel.mount();
    const surface = { model: surfaceModel, el: document.querySelector<HTMLElement>("[data-key-surface]")! };
    const states: number[] = [];
    Object.assign(s, {
      active: true,
      keySurface: surfaceModel,
      onState: () => states.push(1),
      setTool: (t: string) => {
        s.tool = t;
        s.keyDraw.disarm();
        surfaceModel.setStop(KEY_DRAW_TOOLS.has(t));
      },
    });
    surfaceModel.setStop(KEY_DRAW_TOOLS.has(tool));
    document.body.insertAdjacentHTML("beforeend", '<button id="rail">r</button>');
    return { s, calls, surface, states, prompt: () => (s as unknown as { keyPrompt: string | null }).keyPrompt };
  }

  it("a letter arming a draw tool moves focus off a rail button onto the surface and reads the keys prompt", () => {
    const { s, surface, states, prompt } = keysSketch("select");
    const rail = document.getElementById("rail")!;
    rail.focus();
    expect(prompt()).toBeNull();
    key(s, "r", rail);
    expect(s.tool).toBe("rectangle");
    expect(document.activeElement).toBe(surface.el);
    expect(surface.el.tabIndex).toBe(0);
    expect(prompt()).toMatch(/X and Y/);
    expect(states.length).toBeGreaterThan(0);
  });

  it("a letter arming another tool leaves focus and the prompt alone, and takes the surface out of the Tab order", () => {
    const { s, surface, prompt } = keysSketch("line");
    const rail = document.getElementById("rail")!;
    rail.focus();
    key(s, "a", rail);
    expect(s.tool).toBe("arc");
    expect(document.activeElement).toBe(rail);
    expect(surface.el.tabIndex).toBe(-1);
    expect(prompt()).toBeNull();
  });

  it("arming by keys, then switching to another tool, ends the keys prompt", () => {
    const { s, prompt } = keysSketch("select");
    key(s, "c");
    expect(prompt()).not.toBeNull();
    key(s, "t");
    expect(s.tool).toBe("trim");
    expect(prompt()).toBeNull();
  });

  it("Escape closing the X and Y box puts focus back on the surface", () => {
    const { s, surface, prompt } = keysSketch("select");
    key(s, "l");
    key(s, "Enter", surface.el);
    expect(fieldNames()).toEqual(["x", "y"]);
    expect(prompt()).toMatch(/Type X and Y/);
    key(s, "Escape", fieldEl("x"));
    expect(dim?.isActive).toBe(false);
    expect(document.activeElement).toBe(surface.el);
    expect(prompt()).toMatch(/Enter or a digit/);
  });

  it("a point typed in X and Y moves the prompt on to the size", () => {
    const { s, prompt } = keysSketch("select");
    key(s, "r");
    key(s, "Enter");
    typePoint("7", "-3");
    expect(fieldNames()).toEqual(["width", "height"]);
    expect(prompt()).toMatch(/size/);
    expect(prompt()).not.toMatch(/Type X and Y/);
  });

  it("a prompt is null outside a sketch", () => {
    const { s, prompt } = keysSketch("select");
    key(s, "l");
    (s as unknown as { active: boolean }).active = false;
    expect(prompt()).toBeNull();
  });
});

describe("the keyboard cursor in the sketch", () => {
  it("moves the cursor and the hit that inference reads together, exactly", () => {
    const { s, seen } = makeSketch("line");
    s.base = v(5, -7.25);
    expect(key(s, "ArrowRight")).toBe(true);
    expect(s.lastCursor).toEqual(v(20, -7.25));
    expect(s.lastHit).toMatchObject({ p: v(20, -7.25), kind: "free", typed: true });
    expect(s.inferLine(s.lastCursor)?.relations.map((r) => r.type)).toContain("horizontal");
    key(s, "ArrowUp");
    expect(s.lastCursor).toEqual(v(20, 0));
    expect(s.lastHit?.p).toEqual(s.lastCursor);
    expect(seen.tags.length).toBe(2);
  });

  it("shows the grid marker and a silent tag with the coordinates", () => {
    const { s, seen } = makeSketch("rectangle");
    key(s, "ArrowLeft");
    expect(s.lastCursor).toEqual(v(0, -7.25));
    expect(seen.snaps.map((a) => a[1])).toEqual(["grid"]);
    expect(seen.tags).toEqual([["0, -7.25", { x: 300, y: 200 }, { silent: true }]]);
  });

  it("shows a candidate's own kind and name when the cursor lands on one", () => {
    const { s, seen } = makeSketch("circle");
    s.lastCursor.set(-20, 0);
    key(s, "ArrowRight");
    expect(seen.snaps.map((a) => a[1])).toEqual(["center"]);
    expect(seen.tags[0]?.[0]).toBe("Origin");
  });

  it("places a first point at the cursor with Enter and opens the tool's size box", () => {
    const { s } = makeSketch("rectangle");
    key(s, "ArrowRight");
    key(s, "ArrowUp");
    expect(key(s, "Enter")).toBe(true);
    expect(s.base).toEqual(v(20, 0));
    expect(fieldNames()).toEqual(["width", "height"]);
  });

  describe("Tab", () => {
    const line: ResolvedEntity = { type: "line", id: "l1", x1: 60, y1: 10, x2: 100, y2: 50 };
    const withLine = (tool: string) => {
      const r = makeSketch(tool);
      r.s.entities = [line];
      r.s.candidates = [...candidatesFromEntities([line]), ...originCandidate(new SketchPlane("XY"))];
      return r;
    };

    it("is the page's before an arrow and takes the key after one", () => {
      const { s } = withLine("line");
      expect(key(s, "Tab")).toBe(false);
      key(s, "ArrowRight");
      expect(key(s, "Tab")).toBe(true);
    });

    it("walks from the origin to a line's end, names it on the tag, and Enter places it with its ref", () => {
      const { s, seen } = withLine("line");
      key(s, "ArrowRight");
      key(s, "Tab");
      expect(s.lastCursor).toEqual(v(0, 0));
      key(s, "Tab");
      expect(s.lastCursor).toEqual(v(60, 10));
      expect(seen.snaps.at(-1)?.[1]).toBe("endpoint");
      expect(seen.tags.at(-1)?.[0]).toBe("Endpoint");
      key(s, "Enter");
      expect(s.base).toEqual(v(60, 10));
      expect(s.lastHit).toMatchObject({ kind: "endpoint", ref: { entity: "l1", at: 0 } });
      expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toBe("Point at 60, 10, snapped to the start of Line 1");
    });

    it("pins the origin when Tab picked it", () => {
      const { s } = withLine("rectangle");
      key(s, "ArrowRight");
      key(s, "Tab");
      key(s, "Enter");
      expect(s.originPin).toEqual({ at: v(0, 0), count: 1 });
    });

    it("says the midpoint it reached", () => {
      const { s } = withLine("circle");
      key(s, "ArrowRight");
      for (let k = 0; k < 3; k++) key(s, "Tab");
      expect(s.lastCursor).toEqual(v(80, 30));
      expect(vi.mocked(announce).mock.calls.at(-1)?.[0]).toBe("Cursor at 80, 30, snapped to the midpoint of Line 1");
    });
  });

  it("steps by the drawn grid when snapping is off and by the snap lattice when it is on", () => {
    const { s } = makeSketch("line");
    const host = s.keyDrawHost();
    s.planeMmPerPx = () => 0.5;
    expect(host.step()).toBe(20);
    s.gridSnap = true;
    expect(host.step()).toBe(20);
    s.planeMmPerPx = () => 0.0001;
    expect(host.step()).toBe(0.01);
    s.gridSnap = false;
    expect(host.step()).toBe(0.005);
  });
});
