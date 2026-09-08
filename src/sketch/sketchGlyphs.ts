// On-canvas constraint glyphs: small badges projected onto the sketch, mirroring
// SketchDimensions. Each shows a constraint's type; clicking one (in the select
// tool) deletes that constraint. Conflicting constraints render red.
//
// This is now a FACADE. The badges are rendered by
// components/overlays/SketchGlyphLayer.vue out of stores/sketchAnnotations.ts;
// what stays here is the shape SketchMode already talks to, same constructor,
// same show/hide/setInteractive, same onDelete/onOverlapPick hook fields, so
// sketchMode.ts (3,781 lines, zero HTML) did not have to move a line.
//
// The projection loop that used to live at the bottom of this file went to the
// component, NOT to reactivity: 200 badges re-projected on every camera frame
// are style writes, not state. See the component and the store for the split.

import { markRaw } from "vue";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";
import { diagnosisOf, type ConstraintGlyph } from "./glyphs";
import { glyphClass, glyphTitle } from "./annotationFormat";
import { useSketchAnnotationStore, type GlyphHooks } from "../stores/sketchAnnotations";

/** One rendered badge: the glyph's own data plus its presentation, resolved
 *  once here because neither changes without a rebuild. */
export interface GlyphItem extends ConstraintGlyph {
  cls: string;
  title: string;
}

export class SketchGlyphs {
  /** delete the constraint at this index (wired by SketchMode) */
  onDelete: ((cIndex: number) => void) | null = null;
  /** Geometry-beats-glyph, mirroring SketchDimensions.onOverlapPick. A glyph is
   *  a DOM badge above the canvas, so in the dimension tool it would swallow the
   *  click that names an operand. Return true = "the click belonged to the tool
   *  underneath" and the glyph skips its delete for that click. */
  onOverlapPick: ((e: PointerEvent) => boolean) | null = null;

  /** Both hooks are assigned by SketchMode AFTER construction, so this reads
   *  them at call time rather than capturing them. markRaw: it closes over this
   *  instance, which closes over SketchMode. */
  private readonly hooks: GlyphHooks = markRaw({
    overlapPick: (e: PointerEvent) => this.onOverlapPick?.(e) ?? false,
    del: (cIndex: number) => this.onDelete?.(cIndex),
  });

  constructor(private viewport: Viewport) {}

  show(glyphs: ConstraintGlyph[], plane: SketchPlane, conflicts: Set<number>, over: Set<number>) {
    const store = useSketchAnnotationStore();
    store.glyphHooks = this.hooks;
    store.showGlyphs(
      glyphs.map((g) => {
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

  /** glyphs accept clicks in the select and dimension tools; under a drawing tool
   *  they stay click-through. In the dimension tool onOverlapPick above arbitrates,
   *  so a click that names a dimension operand still reaches the tool. */
  setInteractive(on: boolean) {
    useSketchAnnotationStore().glyphsPassive = !on;
  }
}
