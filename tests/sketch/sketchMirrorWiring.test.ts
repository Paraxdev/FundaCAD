// SketchMode's own Mirror wiring: keys, hover, cancel and undo reach the real MirrorFlow. The methods are the real ones
// off the prototype; the viewport, overlay and panels around them are stubs.

import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import * as THREE from "three";
import { SketchMode } from "../../src/sketch/sketchMode";
import { MirrorFlow, type MirrorHost } from "../../src/sketch/mirrorFlow";
import { showMirrorPanel } from "../../src/features/mirrorPanel";
import { useToolPanelStore } from "../../src/stores/toolPanels";
import { setPrompt } from "../../src/ui/prompt";
import type { ResolvedEntity } from "../../src/sketch/snap";

// Node has no DOM: onKey asks isEditableTarget, which tests instanceof against these, and closest() for the panel.
for (const name of ["HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement"]) {
  (globalThis as Record<string, unknown>)[name] ??= class {};
}
class FakeElement {
  constructor(private inPanel: boolean) {}
  closest(sel: string) {
    return sel === ".mirror-panel" && this.inPanel ? this : null;
  }
}
(globalThis as Record<string, unknown>).Element ??= FakeElement;

type Internals = {
  active: boolean;
  tool: string;
  entities: ResolvedEntity[];
  selected: Set<string>;
  mirrorFlow: MirrorFlow;
  setTool(t: string): void;
  cancel(): void;
  onKey(e: Partial<KeyboardEvent>): void;
  onPointerMove(e: Partial<PointerEvent>): void;
  applyHistory(s: unknown): void;
};

// Answers every call and property with itself, for the parts of the canvas these paths only switch off.
const inert: unknown = new Proxy(function () {}, {
  get: (_t, k) => (k === "then" || typeof k === "symbol" ? undefined : inert),
  apply: () => inert,
});

const sketch = (): ResolvedEntity[] => [
  { type: "line", id: "l1", x1: 12, y1: 1.5, x2: -4.25, y2: 7 },
  { type: "line", id: "ax", x1: 3.5, y1: -2, x2: 9.5, y2: 6.25, construction: true },
  { type: "circle", id: "c1", radius: 2.75, x: 8, y: 9 },
];
const ON_AXIS = new THREE.Vector2(6.5, 2.125);
const ON_L1 = new THREE.Vector2(3.875, 4.25);

function makeSketch(pre: string[]) {
  const log = { interactive: [] as boolean[], hovers: [] as (string | null)[], modified: 0, repaints: 0 };
  const s = Object.create(SketchMode.prototype) as Internals;
  let n = 0;
  const host: MirrorHost = {
    entities: () => s.entities,
    selected: () => s.selected,
    pickTol: () => 0.5,
    textAt: () => null,
    loopIdsAt: () => [],
    showPreview: (_c, _l, hover) => log.hovers.push(hover?.id ?? null),
    showPanel: showMirrorPanel,
    prompt: setPrompt,
    warn: () => {},
    refreshActive: () => log.repaints++,
    afterModify: () => log.modified++,
    armSelect: () => s.setTool("select"),
    newId: () => `m${++n}`,
  };
  Object.assign(s, {
    active: true,
    tool: "select",
    entities: sketch(),
    selected: new Set(pre),
    gizmo: null,
    tangentArc: false,
    splinePts: [],
    clickPts: [],
    base: null,
    arcStart: null,
    arcEnd: null,
    chainStart: null,
    originPin: null,
    pendingBindings: new Map(),
    viewSquare: true,
    store: null,
    mirrorFlow: new MirrorFlow(host),
    dims: { setInteractive: (on: boolean) => log.interactive.push(on), deleteSelected: () => false, hide() {} },
    glyphs: { setInteractive() {}, hide() {} },
    dim: { isActive: false, ownsTarget: () => false, hide() {} },
    patternFlow: { hasPending: () => false, flushPending() {} },
    modifyFlow: { offsetting: false, filletArmed: false, reset() {} },
    dimFlow: { picking: false, plan: null, resetDimPicks() {} },
    constraintTools: { hasPending: () => false, resetPending() {} },
    session: inert,
    relations: inert,
    relHover: inert,
    textPanel: inert,
    projectPanel: inert,
    overlay: inert,
    viewport: inert,
    snapTag: inert,
    inferTag: inert,
    cancelBox() {},
    removeGrid() {},
    dropTextPreview: () => false,
    refreshActive: () => log.repaints++,
    planePoint: (e: { clientX: number; clientY: number }) => new THREE.Vector2(e.clientX, e.clientY),
    restore() {},
    requestSolve() {},
  });
  s.setTool("mirror");
  return { s, log };
}

const panel = () => useToolPanelStore().mirror;
const values = () => panel()?.fields.map((f) => f.value) ?? null;
function key(s: Internals, k: string, target: unknown = new FakeElement(false)) {
  let prevented = false;
  s.onKey({
    key: k,
    target: target as EventTarget,
    preventDefault: () => void (prevented = true),
    stopPropagation() {},
  });
  return prevented;
}

beforeEach(() => setActivePinia(createPinia()));

describe("sketch Mirror inside SketchMode", () => {
  it("starts from the selection with the panel up", () => {
    const { s } = makeSketch(["l1"]);
    expect(s.mirrorFlow.running).toBe(true);
    expect(panel()!.active).toBe("line");
    expect(values()).toEqual(["1 object", "Nothing picked"]);
  });

  it("cancel, as New and Open call it, closes the panel and ends the run", () => {
    const { s } = makeSketch(["l1"]);
    s.mirrorFlow.click(ON_AXIS, false);
    s.cancel();
    expect(s.mirrorFlow.running).toBe(false);
    expect(panel()).toBeNull();
    expect(s.entities).toEqual(sketch());
    expect(s.tool).toBe("select");
  });

  it("Enter on the canvas commits the copies and arms Select", () => {
    const { s, log } = makeSketch(["l1", "c1"]);
    s.mirrorFlow.click(ON_AXIS, false);
    expect(key(s, "Enter")).toBe(true);
    expect(s.entities.map((e) => e.id)).toEqual(["l1", "ax", "c1", "m1", "m2"]);
    expect(log.modified).toBe(1);
    expect(s.tool).toBe("select");
    expect(panel()).toBeNull();
  });

  it("Enter and Tab on a panel button are left to the button", () => {
    const { s } = makeSketch(["l1"]);
    s.mirrorFlow.click(ON_AXIS, false);
    const btn = new FakeElement(true);
    expect(key(s, "Enter", btn)).toBe(false);
    expect(key(s, "Tab", btn)).toBe(false);
    expect(s.entities).toHaveLength(3);
    expect(panel()!.active).toBe("line");
  });

  it("Tab on the canvas switches the field", () => {
    const { s } = makeSketch(["l1"]);
    expect(key(s, "Tab")).toBe(true);
    expect(panel()!.active).toBe("objects");
    expect(key(s, "Tab")).toBe(true);
    expect(panel()!.active).toBe("line");
  });

  it("Escape cancels the run and writes nothing", () => {
    const { s } = makeSketch(["l1"]);
    s.mirrorFlow.click(ON_AXIS, false);
    expect(key(s, "Escape")).toBe(true);
    expect(s.mirrorFlow.running).toBe(false);
    expect(panel()).toBeNull();
    expect(s.entities).toEqual(sketch());
    expect([...s.selected]).toEqual(["l1"]);
    expect(s.tool).toBe("select");
  });

  it("Delete is not a delete in the Mirror tool, the objects stay picked", () => {
    const { s } = makeSketch(["l1", "c1"]);
    key(s, "Delete");
    key(s, "Backspace");
    expect(s.entities).toEqual(sketch());
    expect([...s.selected]).toEqual(["l1", "c1"]);
    expect(values()).toEqual(["2 objects", "Nothing picked"]);
  });

  it("undo mid run ends it on Select with the annotations clickable again", () => {
    const { s, log } = makeSketch(["l1"]);
    expect(log.interactive).toEqual([false]);
    s.applyHistory({});
    expect(s.mirrorFlow.running).toBe(false);
    expect(panel()).toBeNull();
    expect(s.tool).toBe("select");
    expect(log.interactive).toEqual([false, true]);
  });

  it("undo in another tool leaves the annotations alone", () => {
    const { s, log } = makeSketch([]);
    s.setTool("line");
    s.applyHistory({});
    expect(s.tool).toBe("line");
    expect(log.interactive).toEqual([false, false]);
  });

  it("moving the pointer lights the line under it", () => {
    const { s, log } = makeSketch(["c1"]);
    s.onPointerMove({ clientX: ON_L1.x, clientY: ON_L1.y });
    expect(log.hovers.at(-1)).toBe("l1");
    s.onPointerMove({ clientX: -40, clientY: 55 });
    expect(log.hovers.at(-1)).toBe(null);
  });
});
