// SketchMode listens for keys on the window in the capture phase, ahead of the sketch palette. Its onKey is the real
// one off the prototype; the palette is the real one, mounted with rows.

import { noKeyDraw, noKeySurface } from "./keyDrawStub";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { SketchMode } from "../../src/sketch/sketchMode";
import SketchPalette from "../../src/components/shell/SketchPalette.vue";
import { useSketchRelationsStore } from "../../src/stores/sketchRelations";
import { relationRows } from "../../src/sketch/relations";

vi.mock("../../src/sketch/solver", () => ({
  SolverUnavailable: class extends Error {},
  initSolver: async () => false,
  solveSketch: async () => {
    throw new Error("no solver in this test");
  },
}));

enableAutoUnmount(afterEach);

let unwire: (() => void) | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = "";
});
afterEach(() => {
  unwire?.();
  unwire = null;
});

function sketchWithSelection() {
  const log: string[] = [];
  const s = Object.create(SketchMode.prototype) as { onKey(e: KeyboardEvent): void };
  Object.assign(s, {
    tool: "spline",
    selected: new Set(["l1", "l2"]),
    splinePts: [{ x: 3.5, y: -2.25 }],
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
    dims: { deleteSelected: () => false, clearSelection() {} },
    glyphs: { deleteSelected: () => false, hasSelection: () => false, clearSelection() {} },
    planeTooEdgeOn: () => false,
    snapAt: () => null,
    deleteSelectedPole: () => false,
    deleteSelected: () => log.push("delete shapes"),
    finishSpline: () => log.push("finish spline"),
    setTool: (t: string) => log.push(`tool ${t}`),
    refreshActive() {},
  });
  const onKey = (e: KeyboardEvent) => s.onKey(e);
  window.addEventListener("keydown", onKey, true);
  unwire = () => window.removeEventListener("keydown", onKey, true);
  return { log, s };
}

function palette(log: string[] = []) {
  const rel = useSketchRelationsStore();
  rel.hooks = {
    del: (i: number) => log.push(`delete rule ${i}`),
    hover() {},
    select() {},
    shapes() {},
  };
  const ents = [
    { type: "line", id: "l1", x1: 20, y1: 3, x2: 26, y2: 5 },
    { type: "line", id: "l2", x1: 26, y1: 5, x2: 21, y2: 9 },
  ] as const;
  rel.show(
    relationRows([...ents], [{ type: "vertical", line: "l1" }], new Set(), new Set()),
    "3 degrees of freedom",
    false,
  );
  return mount(SketchPalette, { attachTo: document.body });
}

const press = (el: Element, k: string) => {
  const e = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};

describe("keys on the sketch palette", () => {
  it("never reach SketchMode from a row, a Delete button or an option", async () => {
    const { log } = sketchWithSelection();
    palette();
    await nextTick();
    const row = document.querySelector<HTMLElement>(".rel-row .ui-list-row")!;
    const del = document.querySelector<HTMLElement>(".rel-del")!;
    const option = document.querySelector<HTMLElement>("#palette input[type=checkbox]")!;
    const pressed = [];
    for (const k of ["Enter", " "]) for (const el of [row, del]) pressed.push(press(el, k));
    // The button's own Enter and Space must reach its click, so nothing may cancel them.
    expect(pressed).toEqual([false, false, false, false]);
    for (const k of ["Enter", " ", "Delete", "Backspace"]) press(option, k);
    for (const k of ["Delete", "Backspace"]) press(del, k);
    press(row, "Delete");
    expect(log).toEqual([]);
  });

  it("still act from the canvas: Enter finishes the spline", async () => {
    const { log } = sketchWithSelection();
    palette();
    await nextTick();
    expect(press(document.body, "Enter")).toBe(true);
    expect(log).toEqual(["finish spline"]);
  });

  it("still delete the selected shapes from the canvas, and not from a row", async () => {
    const { log, s } = sketchWithSelection();
    (s as unknown as { tool: string }).tool = "select";
    palette();
    await nextTick();
    press(document.querySelector(".rel-row .ui-list-row")!, "Delete");
    expect(log).toEqual([]);
    expect(press(document.body, "Delete")).toBe(true);
    press(document.body, "Backspace");
    expect(log).toEqual(["delete shapes", "delete shapes"]);
  });

  it("still pick a tool from a letter typed on the palette", async () => {
    const { log } = sketchWithSelection();
    palette();
    await nextTick();
    press(document.querySelector(".rel-row .ui-list-row")!, "l");
    expect(log).toEqual(["tool line"]);
  });
});

// A mouse click focuses a palette control, and the canvas press after it cancels the browser's own focus move.
describe("keys after a mouse click in the palette and a press on the canvas", () => {
  const canvasPress = (s: object) =>
    (s as { onPointerDown(e: PointerEvent): void }).onPointerDown(
      new MouseEvent("pointerdown", { button: 0, bubbles: true, cancelable: true }) as PointerEvent,
    );
  const pressFocused = (k: string) => press(document.activeElement ?? document.body, k);

  it("delete the selected shapes, not the option clicked before", async () => {
    const { log, s } = sketchWithSelection();
    (s as unknown as { tool: string }).tool = "select";
    palette(log);
    await nextTick();
    document.querySelector<HTMLElement>("#palette input[type=checkbox]")!.focus();
    canvasPress(s);
    expect(pressFocused("Delete")).toBe(true);
    expect(log).toEqual(["delete shapes"]);
  });

  it("finish the spline, not press the Relations row clicked before", async () => {
    const { log, s } = sketchWithSelection();
    palette(log);
    await nextTick();
    document.querySelector<HTMLElement>(".rel-row .ui-list-row")!.focus();
    canvasPress(s);
    expect(pressFocused("Enter")).toBe(true);
    expect(log).toEqual(["finish spline"]);
  });

  it("delete the shapes selected on the canvas, not the rule of the focused Relations row", async () => {
    const { log, s } = sketchWithSelection();
    (s as unknown as { tool: string }).tool = "select";
    palette(log);
    await nextTick();
    const row = document.querySelector<HTMLElement>(".rel-row .ui-list-row")!;
    row.focus();
    pressFocused("Delete");
    expect(log).toEqual(["delete rule 0"]);
    row.focus();
    canvasPress(s);
    pressFocused("Delete");
    expect(log).toEqual(["delete rule 0", "delete shapes"]);
  });
});
