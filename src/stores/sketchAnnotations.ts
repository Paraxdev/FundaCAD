import { defineStore } from "pinia";
import { markRaw, ref, shallowRef } from "vue";
import type * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "../sketch/plane";
import type { DimItem } from "../sketch/sketchDimensions";
import type { GlyphItem } from "../sketch/sketchGlyphs";

/** SketchMode assigns the matching fields on SketchDimensions after construction, so these are read at call time. */
export interface DimHooks {
  overlapPick(e: PointerEvent): boolean;
  planePoint(clientX: number, clientY: number): THREE.Vector2 | null;
  labelMenu(e: MouseEvent, del: (() => void) | null): void;
}

export interface GlyphHooks {
  overlapPick(e: PointerEvent): boolean;
  del(cIndex: number): void;
  editPattern(patternId: string): void;
}

/** Structure of the dimension label and constraint glyph layers, never position: at 60 fps a 200-label sketch is 12,000
 *  style writes a second, so Sketch{Dim,Glyph}Layer.vue write transforms from a rAF loop outside Vue. Everything here
 *  is markRaw: closures over SketchMode, THREE.Vector2 anchors a drag mutates in place, and Three.js objects. */
export const useSketchAnnotationStore = defineStore("sketchAnnotations", () => {
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
    dimItems,
    dimPlane,
    dimViewport,
    dimHooks,
    dimsPassive,
    dimSelected,
    showDims,
    hideDims,
    glyphItems,
    glyphPlane,
    glyphViewport,
    glyphHooks,
    glyphsPassive,
    showGlyphs,
    hideGlyphs,
  };
});
