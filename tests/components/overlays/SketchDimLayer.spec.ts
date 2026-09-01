// The dimension layer is the sharpest edge in the overlay migration, so this
// pins the two things that would break silently.
//
//   1. STRUCTURE vs POSITION. Vue owns which labels exist and what they say;
//      the rAF loop owns where they are. If a screen coordinate ever appears in
//      the store, or a label's position ever becomes a `:style` binding, 200
//      badges start going through the scheduler 60 times a second. The
//      assertions below are on the store's shape and on the rendered element's
//      inline style at first paint.
//   2. RAWNESS. Every item carries commit/placeCommit/onDelete closures over
//      SketchMode and a THREE.Vector2 anchor the drag mutates IN PLACE. If any
//      of it became a Proxy, the loop would read a copy, structuredClone in the
//      undo snapshot would throw, and identity checks in the store would fail.
//
// What this file honestly CANNOT cover: the projection itself, the label drag,
// and the placement maths. happy-dom implements no layout — getBoundingClientRect
// is all zeros, there is no WebGL camera and no pointer capture — so all three
// stay e2e/manual territory. The rAF loop below only ever runs against a stub.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { isReactive, nextTick, toRaw } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SketchDimLayer from "../../../src/components/overlays/SketchDimLayer.vue";
import { useSketchAnnotationStore } from "../../../src/stores/sketchAnnotations";
import { SketchDimensions, type ExtraDim } from "../../../src/sketch/sketchDimensions";
import type { SketchPlane } from "../../../src/sketch/plane";
import type { Viewport } from "../../../src/viewport/viewport";
import type { ResolvedEntity } from "../../../src/sketch/snap";

enableAutoUnmount(afterEach);

// Just enough of each to keep the reprojection loop from throwing if it ticks.
// It cannot produce a meaningful result here and nothing asserts on one.
const plane = {
  to3D: (x: number, y: number, out: THREE.Vector3) => out.set(x, y, 0),
} as unknown as SketchPlane;
const forwardWheel = vi.fn();
const viewport = {
  camera: new THREE.PerspectiveCamera(),
  projectToScreen: () => ({ x: 0, y: 0 }),
  forwardWheel,
} as unknown as Viewport;

function extra(over: Partial<ExtraDim> = {}): ExtraDim {
  return { anchor: new THREE.Vector2(1, 2), valueMm: 40, commit: () => {}, ...over };
}

function dims() {
  return new SketchDimensions(viewport, () => {});
}

const labels = () => document.querySelectorAll<HTMLElement>(".sketch-dim");

describe("SketchDimLayer", () => {
  beforeEach(() => {
    forwardWheel.mockClear();
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("renders nothing until a sketch is opened, and one badge per label after", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    expect(document.querySelector(".sketch-dims")).not.toBeNull();
    expect(labels()).toHaveLength(0);

    dims().show([], plane, [extra(), extra({ valueMm: 12 })]);
    await nextTick();
    expect([...labels()].map((el) => el.textContent)).toEqual(["40 mm", "12 mm"]);
  });

  it("carries an entity's own dimensions through, not just the extras", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const circle: ResolvedEntity = { type: "circle", id: "c", radius: 5, x: 0, y: 0 };
    dims().show([circle], plane, []);
    await nextTick();
    expect([...labels()].map((el) => el.textContent)).toEqual(["10 mm"]); // diameter
  });

  // --- structure vs position ----------------------------------------------
  it("keeps every screen coordinate out of the store", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const anchor = new THREE.Vector2(7, 9);
    dims().show([], plane, [extra({ anchor })]);
    await nextTick();

    const item = useSketchAnnotationStore().dimItems[0]!;
    // sketch mm, and the CALLER's object — the drag mutates this in place and
    // the loop has to see the mutation without a store write
    expect(item.anchor).toBe(anchor);
    expect(Object.keys(item)).not.toContain("x");
    expect(Object.keys(item)).not.toContain("screen");
  });

  it("never writes a position through the template", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    dims().show([], plane, [extra()]);
    await nextTick();
    // At first paint the element has no inline transform at all: the only thing
    // that ever sets one is the rAF loop, imperatively.
    expect(labels()[0]!.getAttribute("style")).toBeNull();
  });

  it("hands the layer raw objects, never reactive proxies", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    dims().show([], plane, [extra()]);
    await nextTick();

    const store = useSketchAnnotationStore();
    const item = store.dimItems[0]!;
    expect(isReactive(store.dimItems)).toBe(false);
    expect(isReactive(item)).toBe(false);
    expect(toRaw(item)).toBe(item);
    expect(isReactive(store.dimPlane)).toBe(false);
  });

  // --- presentation --------------------------------------------------------
  it("marks up driven, formula-bound and solver-flagged labels", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    dims().show([], plane, [
      extra({ driven: true }),
      extra({ expr: "width/2" }),
      extra({ conflict: true }),
      extra({ over: true }),
    ]);
    await nextTick();
    const cls = [...labels()].map((el) => el.className);
    expect(cls[0]).toContain("sketch-dim-driven");
    expect(cls[1]).toContain("sketch-dim-fx");
    expect(cls[2]).toContain("conflict");
    expect(cls[3]).toContain("over");
  });

  it("escapes an expression exactly once in the tooltip", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    dims().show([], plane, [extra({ expr: "a & b" })]);
    await nextTick();
    // A leftover esc() here would show "a &amp; b" to the user.
    expect(labels()[0]!.title).toBe("= a & b · click to edit");
  });

  it("goes click-through under a drawing tool", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const d = dims();
    d.setInteractive(false);
    await nextTick();
    expect(document.querySelector(".sketch-dims")!.className).toContain("dims-passive");
    d.setInteractive(true);
    await nextTick();
    expect(document.querySelector(".sketch-dims")!.className).not.toContain("dims-passive");
  });

  // --- selection + delete --------------------------------------------------
  it("arms the Delete key on the label that was clicked", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const onDelete = vi.fn();
    const d = dims();
    d.show([], plane, [extra(), extra({ onDelete })]);
    await nextTick();

    labels()[1]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await nextTick();
    expect(labels()[1]!.className).toContain("is-selected");
    expect(labels()[0]!.className).not.toContain("is-selected");

    expect(d.deleteSelected()).toBe(true);
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("falls through when the armed label is an entity dim with nothing to delete", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const d = dims();
    d.show([], plane, [extra()]); // no onDelete: a circle's diameter has no constraint
    await nextTick();
    labels()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await nextTick();
    // false, so SketchMode's own Delete handling still runs
    expect(d.deleteSelected()).toBe(false);
  });

  it("drops a selection whose label no longer exists", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const d = dims();
    d.show([], plane, [extra({ onDelete: () => {} })]);
    await nextTick();
    labels()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    await nextTick();

    d.show([], plane, [extra()]); // a rebuild
    await nextTick();
    expect(useSketchAnnotationStore().dimSelected).toBeNull();
    expect(d.deleteSelected()).toBe(false);

    d.clearSelection();
    expect(useSketchAnnotationStore().dimSelected).toBeNull();
  });

  // --- the value editor ----------------------------------------------------
  async function openEditor(over: Partial<ExtraDim> = {}) {
    mount(SketchDimLayer, { attachTo: document.body });
    dims().show([], plane, [extra(over)]);
    await nextTick();
    labels()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    labels()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    return labels()[0]!.querySelector("input")!;
  }

  it("opens the value in display units on click", async () => {
    expect((await openEditor()).value).toBe("40");
  });

  it("reopens the EXPRESSION on a parameter-bound dim, not its value", async () => {
    const input = await openEditor({ expr: "width/2", commitExpr: () => null });
    expect(input.value).toBe("width/2");
  });

  it("does not open an editor on a reference dimension", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    dims().show([], plane, [extra({ driven: true })]);
    await nextTick();
    labels()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    labels()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(labels()[0]!.querySelector("input")).toBeNull();
  });

  it("commits a plain number through commit()", async () => {
    const commit = vi.fn();
    const input = await openEditor({ commit });
    input.value = "55";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(commit).toHaveBeenCalledWith(55);
  });

  it("routes a formula — and any edit to an already-bound dim — through commitExpr", async () => {
    const commit = vi.fn();
    const commitExpr = vi.fn(() => null);
    const input = await openEditor({ commit, commitExpr });
    input.value = "width/2";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(commitExpr).toHaveBeenCalledWith("width/2");
    expect(commit).not.toHaveBeenCalled();
  });

  it("keeps a rejected expression on screen, flagged, instead of reverting", async () => {
    const input = await openEditor({ commitExpr: () => "no such parameter" });
    input.value = "nope";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await nextTick();
    const live = labels()[0]!.querySelector("input")!;
    expect(live.className).toContain("input-error");
    expect(live.title).toBe("no such parameter");
  });

  it("rejects a non-positive length and reverts", async () => {
    const commit = vi.fn();
    const input = await openEditor({ commit });
    input.value = "-5";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    await nextTick();
    expect(commit).not.toHaveBeenCalled();
    expect(labels()[0]!.querySelector("input")).toBeNull();
    expect(labels()[0]!.textContent).toBe("40 mm");
  });

  it("accepts a negative ANGLE, which is a signed value", async () => {
    const commit = vi.fn();
    const input = await openEditor({ kind: "angle", commit });
    input.value = "-30";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(commit).toHaveBeenCalledWith(-30);
  });

  it("reverts on Escape and keeps the keystroke out of the global keymap", async () => {
    const onGlobalKey = vi.fn();
    document.addEventListener("keydown", onGlobalKey);
    const input = await openEditor();
    input.value = "999";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await nextTick();
    expect(labels()[0]!.textContent).toBe("40 mm");
    expect(onGlobalKey).not.toHaveBeenCalled();
    document.removeEventListener("keydown", onGlobalKey);
  });

  // A badge takes pointer events so it can be clicked, dragged and edited, and
  // the viewport's own wheel listener is on the CANVAS. With the cursor over a
  // badge the wheel therefore reached nothing, and the view did not zoom — on a
  // small profile, where the badges cover most of the drawing, that is the
  // normal case rather than the corner one. The layer hands the notch back.
  //
  // Asserted on the CONTAINER, which is where the listener has to be: in a
  // drawing tool the badges are `pointer-events: none` (dims-passive) and the
  // notch never touches one, but the layer is still stretched over the canvas.
  it("hands a wheel notch back to the viewport", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const d = dims();
    d.show([], plane, [extra()]);
    await nextTick();
    const layer = document.querySelector<HTMLElement>(".sketch-dims")!;
    layer.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    expect(forwardWheel).toHaveBeenCalledTimes(1);
    expect((forwardWheel.mock.calls[0]![0] as WheelEvent).deltaY).toBe(-120);
  });

  it("hands one back that bubbled up off a badge", async () => {
    mount(SketchDimLayer, { attachTo: document.body });
    const d = dims();
    d.show([], plane, [extra()]);
    await nextTick();
    labels()[0]!.dispatchEvent(new WheelEvent("wheel", { deltaY: 120, bubbles: true }));
    expect(forwardWheel).toHaveBeenCalledTimes(1);
  });
});
