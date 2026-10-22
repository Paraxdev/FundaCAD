// On-canvas constraint glyph badges, a facade over SketchGlyphLayer.vue and stores/sketchAnnotations.ts. The
// projection runs in the component, not through reactivity: 200 badges re-projected per frame are style writes.

import { markRaw } from "vue";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";
import { diagnosisOf, type ConstraintGlyph } from "./glyphs";
import { glyphClass, glyphTitle } from "./annotationFormat";
import { useSketchAnnotationStore, type GlyphHooks } from "../stores/sketchAnnotations";

/** Presentation is resolved once here, neither changes without a rebuild. */
export interface GlyphItem extends ConstraintGlyph {
  cls: string;
  title: string;
}

export class SketchGlyphs {
  onDelete: ((cIndex: number) => void) | null = null;
  onEditPattern: ((patternId: string) => void) | null = null;
  /** In the dimension tool a badge would swallow the click that names an operand. Returning true means the click
   *  belonged to the tool underneath, so the glyph skips its delete. */
  onOverlapPick: ((e: PointerEvent) => boolean) | null = null;

  /** Read at call time, SketchMode assigns the hooks after construction. markRaw: it closes over SketchMode. */
  private readonly hooks: GlyphHooks = markRaw({
    overlapPick: (e: PointerEvent) => this.onOverlapPick?.(e) ?? false,
    del: (cIndex: number) => this.onDelete?.(cIndex),
    editPattern: (patternId: string) => this.onEditPattern?.(patternId),
  });

  constructor(private viewport: Viewport) {}

  show(glyphs: ConstraintGlyph[], plane: SketchPlane, conflicts: Set<number>, over: Set<number>) {
    const store = useSketchAnnotationStore();
    store.glyphHooks = this.hooks;
    store.showGlyphs(
      glyphs.map((g) => {
        if (g.patternId) return markRaw<GlyphItem>({ ...g, cls: "sketch-glyph pattern", title: "Edit pattern" });
        const st = diagnosisOf(g.cIndex, conflicts, over);
        // markRaw: `pos` is a THREE.Vector2 the layer projects every frame.
        return markRaw<GlyphItem>({ ...g, cls: glyphClass(st), title: glyphTitle(st) });
      }),
      plane,
      this.viewport,
    );
  }

  hide() {
    useSketchAnnotationStore().hideGlyphs();
  }

  /** In the dimension tool onOverlapPick arbitrates, so a click naming an operand still reaches the tool. */
  setInteractive(on: boolean) {
    useSketchAnnotationStore().glyphsPassive = !on;
  }
}
