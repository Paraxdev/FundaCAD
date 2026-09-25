// SK-10: a Rectangle started on the Origin and cancelled with Escape left a
// fixed construction point behind, invisible, kept through undo and exit. The
// pin now waits for the shape to commit.
//
// The methods are the real ones off the prototype; only the viewport, overlay
// and solver around them are stubs.

import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { SketchMode } from "../../src/sketch/sketchMode";
import type { ResolvedEntity } from "../../src/sketch/snap";
import type { SketchConstraint } from "../../src/types";

// Node has no DOM, and onKey asks isEditableTarget, which tests instanceof
// against these.
for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"]) {
  (globalThis as Record<string, unknown>)[name] ??= class {};
}

type Internals = {
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  base: THREE.Vector2 | null;
  tool: string;
  onPointerDown(e: Partial<PointerEvent>): void;
  onKey(e: Partial<KeyboardEvent>): void;
  requestSolve(): void;
  setTool(t: string): void;
};

function makeSketch(tool: string) {
  const s = Object.create(SketchMode.prototype) as Internals;
  Object.assign(s, {
    active: false, // keeps bankIfChanged and the solve pump out of it
    tool,
    entities: [],
    constraints: [],
    patterns: [],
    selected: new Set<string>(),
    splinePts: [],
    clickPts: [],
    base: null,
    chainStart: null,
    arcStart: null,
    arcEnd: null,
    originPin: null,
    dims: { clearSelection() {}, setInteractive() {} },
    glyphs: { setInteractive() {} },
    dim: { isActive: false, ownsTarget: () => false, hide() {} },
    patternFlow: { hasPending: () => false, flushPending() {} },
    modifyFlow: { offsetting: false, filletArmed: false, setFilletFirst() {}, reset() {} },
    dimFlow: { picking: false, plan: null, resetDimPicks() {} },
    constraintTools: { hasPending: () => false, resetPending() {} },
    overlay: { setPreview() {} },
    textPanel: { hide() {} },
    projectPanel: { hide() {} },
    viewport: { hoverEntity() {}, domElement: {} },
    planeTooEdgeOn: () => false,
    snapAt: () => ({ kind: "center", label: "Origin", p: new THREE.Vector2(0, 0) }),
    showDimFields() {},
    cancelBox() {},
    dropTextPreview: () => false,
    refreshActive() {},
    pump: async () => {},
  });
  return s;
}

const press = (s: Internals) =>
  s.onPointerDown({ button: 0, clientX: 100, clientY: 100, ctrlKey: false, preventDefault() {} });
const escape = (s: Internals) =>
  s.onKey({ key: "Escape", target: null, preventDefault() {}, stopPropagation() {} });
const rect = (): ResolvedEntity => ({ type: "rectangle", id: "r1", x: 10, y: 5, width: 20, height: 10 });

describe("SK-10: an origin pin waits for its shape", () => {
  it("a rectangle begun on the Origin and cancelled with Escape leaves nothing", () => {
    const s = makeSketch("rectangle");
    press(s);
    expect(s.base).not.toBeNull();
    expect(s.entities).toEqual([]);
    escape(s);
    expect(s.base).toBeNull();
    s.requestSolve();
    expect(s.entities).toEqual([]);
    expect(s.constraints).toEqual([]);
  });

  it("a later shape elsewhere does not collect the cancelled pin", () => {
    const s = makeSketch("rectangle");
    press(s);
    escape(s);
    s.entities.push(rect());
    s.requestSolve();
    expect(s.entities.map((e) => e.type)).toEqual(["rectangle"]);
    expect(s.constraints).toEqual([]);
  });

  it("switching tools mid-shape drops the pin too", () => {
    const s = makeSketch("rectangle");
    press(s);
    s.setTool("circle");
    s.entities.push({ type: "circle", id: "c1", x: 30, y: 30, radius: 2 });
    s.requestSolve();
    expect(s.entities.some((e) => e.type === "point")).toBe(false);
  });

  it("a committed shape still gets its fixed Origin point (SK-6)", () => {
    const s = makeSketch("rectangle");
    press(s);
    s.entities.push(rect());
    s.requestSolve();
    const pin = s.entities.find((e) => e.type === "point");
    expect(pin).toMatchObject({ x: 0, y: 0, construction: true });
    expect(s.constraints).toEqual([{ type: "fix", e: pin!.id, p: 0 }]);
  });
});
