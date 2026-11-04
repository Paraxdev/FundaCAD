// The constraint-glyph layer, checked for the same split as SketchDimLayer: Vue
// owns which badges exist, the rAF loop owns where they are. The projection
// itself is not reachable here (no layout, no WebGL camera), so what is pinned
// is the store's shape, the rawness of what lands in it, and the click
// arbitration that lets the dimension tool take a click on a badge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { isReactive, nextTick } from "vue";
import { enableAutoUnmount, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import SketchGlyphLayer from "../../../src/components/overlays/SketchGlyphLayer.vue";
import { useSketchAnnotationStore } from "../../../src/stores/sketchAnnotations";
import { SketchGlyphs } from "../../../src/sketch/sketchGlyphs";
import type { ConstraintGlyph } from "../../../src/sketch/glyphs";
import type { SketchPlane } from "../../../src/sketch/plane";
import type { Viewport } from "../../../src/viewport/viewport";

enableAutoUnmount(afterEach);

const plane = {
  to3D: (x: number, y: number, out: THREE.Vector3) => out.set(x, y, 0),
} as unknown as SketchPlane;
const forwardWheel = vi.fn();
const viewport = {
  camera: new THREE.PerspectiveCamera(),
  rig: { poseVersion: () => 0 },
  projectToScreen: () => ({ x: 0, y: 0 }),
  forwardWheel,
} as unknown as Viewport;

const glyph = (cIndex: number, icon = "perpendicular"): ConstraintGlyph => ({
  cIndex,
  icon,
  pos: new THREE.Vector2(cIndex, cIndex),
});

const badges = () => document.querySelectorAll<HTMLElement>(".sketch-glyph");

describe("SketchGlyphLayer", () => {
  beforeEach(() => {
    forwardWheel.mockClear();
    setActivePinia(createPinia());
    document.body.innerHTML = "";
  });

  it("renders one badge per glyph, showing the constraint's icon", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    new SketchGlyphs(viewport).show([glyph(0, "equal"), glyph(1, "perpendicular")], plane, new Set(), new Set());
    await nextTick();
    expect([...badges()].map((el) => el.querySelector("svg")?.dataset.icon)).toEqual(["equal", "perpendicular"]);
  });

  it("colours conflicting red and redundant amber, with conflict winning", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    new SketchGlyphs(viewport).show([glyph(0), glyph(1), glyph(2)], plane, new Set([0, 2]), new Set([1, 2]));
    await nextTick();
    const cls = [...badges()].map((el) => el.className);
    expect(cls[0]).toBe("sketch-glyph conflict");
    expect(cls[1]).toBe("sketch-glyph over");
    expect(cls[2]).toBe("sketch-glyph conflict"); // flagged both ways
    expect(badges()[0]!.title).toContain("Conflicting");
  });

  it("keeps positions out of the store and out of the template", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    const g = glyph(0);
    new SketchGlyphs(viewport).show([g], plane, new Set(), new Set());
    await nextTick();

    const store = useSketchAnnotationStore();
    const item = store.glyphItems[0]!;
    expect(item.pos).toBe(g.pos); // the caller's sketch-mm Vector2, by identity
    expect(isReactive(item)).toBe(false);
    expect(isReactive(store.glyphItems)).toBe(false);
    // only the rAF loop ever writes a transform, and it has not ticked yet
    expect(badges()[0]!.getAttribute("style")).toBeNull();
  });

  it("selects the constraint the badge stands for, and never deletes it", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    const g = new SketchGlyphs(viewport);
    const onSelect = vi.fn();
    const onDelete = vi.fn();
    g.onSelect = onSelect; // assigned AFTER construction, as SketchMode does
    g.onDelete = onDelete;
    g.show([glyph(3), glyph(7)], plane, new Set(), new Set());
    await nextTick();
    badges()[1]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect.mock.calls).toEqual([[7]]);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("marks only the selected badge, and a rebuild drops the mark", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    const g = new SketchGlyphs(viewport);
    g.show([glyph(3), glyph(7), glyph(9)], plane, new Set(), new Set());
    g.markSelected(7);
    await nextTick();
    expect([...badges()].map((el) => el.classList.contains("is-selected"))).toEqual([false, true, false]);

    g.show([glyph(3), glyph(7)], plane, new Set(), new Set());
    await nextTick();
    expect([...badges()].map((el) => el.classList.contains("is-selected"))).toEqual([false, false]);
    expect(g.deleteSelected()).toBe(false);
  });

  it("deletes the selected constraint once, and falls through when none is selected", () => {
    const g = new SketchGlyphs(viewport);
    const onDelete = vi.fn();
    g.onDelete = onDelete;
    g.show([glyph(3), glyph(7)], plane, new Set(), new Set());
    expect(g.deleteSelected()).toBe(false);
    expect(onDelete).not.toHaveBeenCalled();

    g.markSelected(7);
    expect(g.hasSelection()).toBe(true);
    expect(g.deleteSelected()).toBe(true);
    expect(g.deleteSelected()).toBe(false);
    expect(g.hasSelection()).toBe(false);
    expect(onDelete.mock.calls).toEqual([[7]]);

    g.markSelected(3);
    g.clearSelection();
    expect(g.deleteSelected()).toBe(false);
    g.markSelected(3);
    g.hide();
    expect(g.hasSelection()).toBe(false);
  });

  it("still edits a pattern glyph instead of selecting it", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    const g = new SketchGlyphs(viewport);
    const onSelect = vi.fn();
    const onEditPattern = vi.fn();
    g.onSelect = onSelect;
    g.onEditPattern = onEditPattern;
    g.show([{ ...glyph(-1, "pattern"), patternId: "p4" }, glyph(2)], plane, new Set(), new Set());
    await nextTick();
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect([onEditPattern.mock.calls, onSelect.mock.calls]).toEqual([[["p4"]], []]);
  });

  // Geometry is preferred over glyph: in the dimension tool a badge sitting on the entity it
  // describes would otherwise swallow the click that names an operand.
  it("skips its select when the tool underneath claimed the pointerdown", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    const g = new SketchGlyphs(viewport);
    const onSelect = vi.fn();
    g.onSelect = onSelect;
    g.onOverlapPick = () => true;
    g.show([glyph(5)], plane, new Set(), new Set());
    await nextTick();

    badges()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect).not.toHaveBeenCalled();

    // and only for THAT click, the suppression is consumed, not sticky
    g.onOverlapPick = () => false;
    badges()[0]!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    badges()[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onSelect.mock.calls).toEqual([[5]]);
  });

  it("goes click-through under a drawing tool, and empties on hide", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    const g = new SketchGlyphs(viewport);
    g.show([glyph(0)], plane, new Set(), new Set());
    g.setInteractive(false);
    await nextTick();
    expect(document.querySelector(".sketch-glyphs")!.className).toContain("glyphs-passive");

    g.hide();
    await nextTick();
    expect(badges()).toHaveLength(0);
    expect(useSketchAnnotationStore().glyphPlane).toBeNull();
  });

  // Same reason as the dimension layer: a badge that takes the pointer also
  // takes the wheel, and the viewport's wheel listener is on the canvas. On the
  // CONTAINER, so a notch over a passive badge is caught too.
  it("hands a wheel notch back to the viewport", async () => {
    mount(SketchGlyphLayer, { attachTo: document.body });
    const g = new SketchGlyphs(viewport);
    g.show([glyph(0)], plane, new Set(), new Set());
    await nextTick();
    badges()[0]!.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
    expect(forwardWheel).toHaveBeenCalledTimes(1);
    expect((forwardWheel.mock.calls[0]![0] as WheelEvent).deltaY).toBe(-120);
  });
});
