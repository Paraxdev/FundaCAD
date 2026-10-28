// A focused menu row takes arrows, Enter and type ahead letters. The tools listen on window in capture, so they hear
// the key before the menu does and must leave it alone, or a letter switches the sketch tool and Enter commits twice.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { SketchMode } from "../../src/sketch/sketchMode";
import { DimInput } from "../../src/sketch/dimInput";
import { CanvasGesture } from "../../src/features/canvasGesture";
import { ExtrudeTool } from "../../src/features/extrudeTool";
import { LoftTool } from "../../src/features/loftTool";
import { TargetEditTool } from "../../src/features/targetEditTool";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

type KeyFn = (e: KeyboardEvent) => void;

let row: HTMLElement;
let other: HTMLElement;
let off: (() => void)[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = `<div class="ui-menu" role="menu"><div class="ui-menu-item" role="menuitem" tabindex="0">Tangent</div></div><canvas></canvas>`;
  row = document.querySelector(".ui-menu-item")!;
  other = document.querySelector("canvas")!;
});
afterEach(() => {
  for (const f of off) f();
  off = [];
  document.body.innerHTML = "";
});

function onWindow(fn: KeyFn) {
  window.addEventListener("keydown", fn, true);
  off.push(() => window.removeEventListener("keydown", fn, true));
}

function press(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
}

function sketch() {
  const calls: string[] = [];
  const s = Object.create(SketchMode.prototype) as { onKey: KeyFn };
  Object.assign(s, {
    tool: "select",
    selected: new Set(["l1"]),
    base: {},
    dim: { isActive: false, ownsTarget: () => false },
    patternFlow: { hasPending: () => false },
    mirrorFlow: { running: false },
    dims: { deleteSelected: () => false },
    deleteSelectedPole: () => false,
    deleteSelected: () => calls.push("delete"),
    setTool: (t: string) => calls.push(`tool ${t}`),
    setTangentArc: () => calls.push("tangent arc"),
    commitFromCursor: () => calls.push("commit"),
    lastCursor: {},
  });
  onWindow((e) => s.onKey(e));
  return calls;
}

describe("keys a focused menu row owns", () => {
  it("leave the sketch tool and its selection alone", () => {
    const calls = sketch();
    for (const key of ["t", "c", "Enter", "ArrowDown"]) press(row, key);
    expect(calls).toEqual([]);
  });

  it("still reach the sketch from the canvas, and Delete still reaches it from a row", () => {
    const calls = sketch();
    press(other, "t");
    press(other, "Enter");
    press(row, "Delete");
    expect(calls).toEqual(["tool trim", "commit", "delete"]);
  });

  it("never reach a canvas gesture tool's key handler", () => {
    const seen: string[] = [];
    const g = new CanvasGesture(other, { move() {}, down() {}, key: (e) => seen.push(e.key) });
    g.attach();
    off.push(() => g.detach());
    press(row, "Enter");
    press(row, "a");
    press(row, "Delete");
    press(other, "Enter");
    expect(seen).toEqual(["Delete", "Enter"]);
  });

  it("let a keydown with no key through to the tool", () => {
    const seen: string[] = [];
    const g = new CanvasGesture(other, { move() {}, down() {}, key: (e) => seen.push(e.type) });
    g.attach();
    off.push(() => g.detach());
    row.dispatchEvent(new Event("keydown", { bubbles: true }));
    expect(seen).toEqual(["keydown"]);
  });

  it("leave Enter to the row in extrude, loft and target edit", () => {
    const calls: string[] = [];
    const extrude = Object.create(ExtrudeTool.prototype) as { onKey: KeyFn };
    Object.assign(extrude, {
      phase: "pick",
      selected: [{}],
      dim: { isActive: false },
      beginDrag: () => calls.push("extrude"),
    });
    const loft = Object.create(LoftTool.prototype) as { onKey: KeyFn };
    Object.assign(loft, { commit: () => calls.push("loft"), cancel: () => calls.push("loft cancel") });
    const target = Object.create(TargetEditTool.prototype) as { onKey: KeyFn };
    Object.assign(target, { active: true, commit: () => calls.push("target"), cancel: () => {} });
    for (const t of [extrude, loft, target]) onWindow((e) => t.onKey(e));
    press(row, "Enter");
    expect(calls).toEqual([]);
    press(other, "Enter");
    expect(calls).toEqual(["extrude", "loft", "target"]);
  });

  it("leave a value box's segment keys alone", () => {
    const dim = new DimInput();
    off.push(() => dim.dispose());
    const picked: string[] = [];
    dim.show([{ name: "size", label: "Size" }], () => {}, undefined, {
      name: "kind",
      title: "Kind",
      chosen: "a",
      onChoose: (id) => picked.push(id),
      segments: ["a", "b"].map((id) => ({ id, label: id.toUpperCase(), icon: "plus", key: id })),
    });
    press(row, "b");
    expect(picked).toEqual([]);
    press(other, "b");
    expect(picked).toEqual(["b"]);
  });
});
