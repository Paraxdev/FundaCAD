import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "../sketch/plane";
import type { DimItem } from "../sketch/sketchDimensions";
import type { GlyphItem } from "../sketch/sketchGlyphs";

/** Late-bound hooks the dimension layer calls back into. SketchMode assigns the
 *  matching public fields on SketchDimensions AFTER construction, so these read
 *  them at call time rather than capturing them. */
export interface DimHooks {
  overlapPick(e: PointerEvent): boolean;
  planePoint(clientX: number, clientY: number): THREE.Vector2 | null;
  labelMenu(e: MouseEvent, del: (() => void) | null): void;
}

export interface GlyphHooks {
  overlapPick(e: PointerEvent): boolean;
  del(cIndex: number): void;
}

/** The two projected badge layers over the sketch: editable dimension labels and
 *  constraint glyphs.
 *
 *  SPLIT OF RESPONSIBILITY, and it is the whole reason this store looks the way
 *  it does: everything here is STRUCTURE, which badges exist, what each says,
 *  which classes it wears, which one the Delete key is armed on. POSITION is not
 *  here and must never be. Both layers project every badge from sketch mm to
 *  screen px on each frame the camera moves; a 200-label sketch at 60 fps is
 *  12,000 style writes a second, and routing those through Vue's scheduler would
 *  be a performance disaster. The components collect their elements into a plain
 *  (non-reactive, non-ref) array and write `style.transform` directly from a rAF
 *  loop, see Sketch{Dim,Glyph}Layer.vue.
 *
 *  shallowRef throughout, and markRaw on everything that lands here: the items
 *  carry commit/placeCommit/onDelete closures over SketchMode and the raw
 *  document, the anchors are THREE.Vector2s a drag mutates IN PLACE, and the
 *  plane and viewport are Three.js objects. None of it may become a Proxy. */
export const useSketchAnnotationStore = defineStore("sketchAnnotations", () => {
  // --- dimension labels ---------------------------------------------------
  const dimItems = shallowRef<readonly DimItem[]>([]);
  const dimPlane = shallowRef<SketchPlane | null>(null);
  const dimViewport = shallowRef<Viewport | null>(null);
  const dimHooks = shallowRef<DimHooks | null>(null);
  /** false under a drawing tool: labels stay visible but click-through. */
  const dimsPassive = ref(false);
  /** index into dimItems of the label the Delete key acts on, or null. */
  const dimSelected = ref<number | null>(null);

  function showDims(items: DimItem[], plane: SketchPlane, viewport: Viewport) {
    dimSelected.value = null;
    dimViewport.value = markRaw(viewport);
    dimPlane.value = markRaw(plane);
    dimItems.value = markRaw(items);
  }

  function hideDims() {
    dimSelected.value = null;
    dimPlane.value = null;
    dimItems.value = [];
  }

  // --- constraint glyphs --------------------------------------------------
  const glyphItems = shallowRef<readonly GlyphItem[]>([]);
  const glyphPlane = shallowRef<SketchPlane | null>(null);
  const glyphViewport = shallowRef<Viewport | null>(null);
  const glyphHooks = shallowRef<GlyphHooks | null>(null);
  const glyphsPassive = ref(false);

  function showGlyphs(items: GlyphItem[], plane: SketchPlane, viewport: Viewport) {
    glyphViewport.value = markRaw(viewport);
    glyphPlane.value = markRaw(plane);
    glyphItems.value = markRaw(items);
  }

  function hideGlyphs() {
    glyphPlane.value = null;
    glyphItems.value = [];
  }

  return {
    dimItems, dimPlane, dimViewport, dimHooks, dimsPassive, dimSelected, showDims, hideDims,
    glyphItems, glyphPlane, glyphViewport, glyphHooks, glyphsPassive, showGlyphs, hideGlyphs,
  };
});
