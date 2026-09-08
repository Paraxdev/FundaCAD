// Persistent, editable dimension annotations on committed sketch geometry. Each
// label is projected onto the geometry; click it to type a new value in the current
// display unit. This is the "edit the length later" half, the live W/H boxes handle
// creation. The dimension set comes from entityDims(), shared with the value rows
// and SketchMode.editDimension.
//
// Now a FACADE: the labels are rendered by components/overlays/SketchDimLayer.vue
// out of stores/sketchAnnotations.ts, and the drag, value editor and per-frame
// reprojection live there (the last deliberately outside reactivity). What stays is
// exactly the surface SketchMode already talks to, so sketchMode.ts did not move a
// line.

import type * as THREE from "three";
import { markRaw } from "vue";
import type { Viewport } from "../viewport/viewport";
import type { SketchPlane } from "./plane";
import type { ResolvedEntity } from "./snap";
import { entityDims, staggeredDefaults, type DimField } from "./entityDims";
import { dimClass, dimTitle, fmtDim, isFormula, type DimKind } from "./annotationFormat";
import { useSketchAnnotationStore, type DimHooks } from "../stores/sketchAnnotations";

export interface DimLabel {
  anchor: THREE.Vector2;
  valueMm: number;
  commit: (mm: number) => void; // writes the value (entity field or constraint)
  kind?: DimKind; // default length; angle → degrees, no unit scaling
  driven?: boolean; // reference dim: bracketed + read-only
  conflict?: boolean; // solver flagged it inconsistent (red)
  over?: boolean; // solver flagged it redundant / over-defining (amber)
  suppressEdit?: boolean; // pointerdown was forwarded to geometry underneath
  /** the driving expression when this dim is parameter-bound, editing reopens
   *  it, the label renders `fx: <value>` when it's not a plain literal */
  expr?: string;
  /** expression-capable commit: gets the RAW input (number or formula) and
   *  returns an error to show, or null. Formulas, and any edit on an
   *  already-bound dim, route through this; a plain number on an unbound dim
   *  keeps the legacy numeric `commit` (non-bindable fields reject formulas). */
  commitExpr?: (raw: string) => string | null;
  /** The label's current offset from its dimension's natural anchor, in sketch
   *  mm, the basis a drag adds its cursor delta to (see EntityDim.place).
   *  Present together with `placeCommit` on every draggable label. */
  place?: THREE.Vector2;
  /** Persist a dragged placement (sketch mm). `done` = the drag ended, so the
   *  host may rebuild everything; while false it must keep this label alive.
   *  Returns the dim's recomputed label anchor, the label follows THAT, not the
   *  raw cursor, so a dim that only moves perpendicular (or radially) never
   *  jumps on release. */
  placeCommit?: (ox: number, oy: number, done: boolean) => THREE.Vector2 | null;
  /** Remove the constraint this label drives. Present ONLY on constraint-backed
   *  dims: an entity dim (a circle's diameter, a rectangle's width) is an
   *  intrinsic property of the entity with no constraint to delete, so its
   *  label offers the action disabled rather than not at all. */
  onDelete?: () => void;
}

/** an extra, non-entity label (e.g. a distance constraint's value); valueMm
 *  is degrees when kind === "angle" */
export type ExtraDim = Omit<DimLabel, "suppressEdit">;

/** A label plus its presentation. Text, classes and tooltip are resolved once,
 *  at show() time, because none of them can change without a rebuild, which is
 *  what lets the component render them and leave the per-frame work alone. */
export interface DimItem extends DimLabel {
  text: string;
  cls: string;
  title: string;
  fx: boolean;
}

export class SketchDimensions {
  /** Geometry-beats-label: a badge can sit ON the entity it labels (low zoom),
   *  and since it's a DOM element above the canvas it would swallow the click
   *  meant to SELECT that entity. The owner installs this hook; return true =
   *  "geometry under the cursor claimed the click", the label then skips its
   *  value-edit for that click. */
  onOverlapPick: ((e: PointerEvent) => boolean) | null = null;
  /** Screen px → sketch-plane mm. The owner installs it (SketchMode's own
   *  unsnapped cursor→plane routine), so a label drag converts through the REAL
   *  plane, no guessed scale factor, and correct on an XZ/YZ/datum plane whose
   *  +Y need not run the same way as the screen's. Without it, labels aren't
   *  draggable. */
  onPlanePoint: ((clientX: number, clientY: number) => THREE.Vector2 | null) | null = null;
  /** Persist a dragged ENTITY badge placement (rect W/H, circle diameter,
   *  polygon radius, slot L/W, line length), those have no backing constraint,
   *  so their placement lives on the entity. Same contract as
   *  DimLabel.placeCommit; `index` indexes the array passed to show(). */
  onEntityPlace:
    | ((index: number, field: DimField, ox: number, oy: number, done: boolean) => THREE.Vector2 | null)
    | null = null;
  /** Right-click on a label. The owner renders the menu (this class owns no menu
   *  UI); `del` is the label's delete action, or null when the label is an entity
   *  dim and there is nothing to delete. */
  onLabelMenu: ((e: MouseEvent, del: (() => void) | null) => void) | null = null;

  /** All four hooks above are assigned by SketchMode AFTER construction, so
   *  these read them at call time rather than capturing them. markRaw: they
   *  close over this instance, which closes over SketchMode and the document. */
  private readonly hooks: DimHooks = markRaw({
    overlapPick: (e: PointerEvent) => this.onOverlapPick?.(e) ?? false,
    planePoint: (cx: number, cy: number) => this.onPlanePoint?.(cx, cy) ?? null,
    labelMenu: (e: MouseEvent, del: (() => void) | null) => this.onLabelMenu?.(e, del),
  });

  constructor(
    private viewport: Viewport,
    private onEdit: (index: number, field: DimField, mm: number) => void,
    /** expression-capable entity-dim commit (raw input → error | null); when
     *  set, entity labels accept formulas too. */
    private onEditExpr?: (index: number, field: DimField, raw: string) => string | null,
    /** the driving expression for an entity dim, when parameter-bound. */
    private entityExprOf?: (index: number, field: DimField) => string | undefined,
  ) {}

  show(entities: ResolvedEntity[], plane: SketchPlane, extras: ExtraDim[] = []) {
    const items: DimItem[] = [];
    // neighbour-aware default placements (concentric circles fan their diameter
    // badges out instead of stacking), the same call dimensionSegments makes,
    // so a label and its own annotation lines never disagree
    const defaults = staggeredDefaults(entities);
    entities.forEach((e, i) => {
      for (const d of entityDims(e, defaults.get(e.id))) {
        const expr = this.entityExprOf?.(i, d.field);
        const field = d.field;
        items.push(present({
          anchor: d.labelPos,
          valueMm: d.valueMm,
          commit: (mm) => this.onEdit(i, field, mm),
          place: d.place,
          placeCommit: (ox, oy, done) => this.onEntityPlace?.(i, field, ox, oy, done) ?? null,
          ...(this.onEditExpr ? { commitExpr: (raw: string) => this.onEditExpr!(i, field, raw) } : {}),
          ...(expr ? { expr } : {}),
        }));
      }
    });
    for (const x of extras) items.push(present(x));

    const store = useSketchAnnotationStore();
    store.dimHooks = this.hooks;
    store.showDims(items, plane, this.viewport);
  }

  hide() {
    useSketchAnnotationStore().hideDims();
  }

  /** Labels accept clicks in the select AND dimension tools. While a DRAWING tool
   *  is active they stay visible but pointer-transparent, a label floating over a
   *  circle's center must not swallow the pick underneath it. The dimension tool
   *  is live despite that same risk because it re-arms after every commit, so
   *  labels were unreachable for as long as anyone was dimensioning; SketchMode's
   *  labelOverlapDimension arbitrates, giving the tool any click that lands on
   *  geometry or that belongs to a part-placed dimension. */
  setInteractive(on: boolean) {
    useSketchAnnotationStore().dimsPassive = !on;
  }

  /** Drop the selection (the owner calls this when the click landed elsewhere). */
  clearSelection() {
    useSketchAnnotationStore().dimSelected = null;
  }

  /** Delete the selected dimension. Returns false when nothing is selected, or
   *  when the selected label is an entity dim with no constraint behind it, so
   *  the caller can fall through to its own Delete handling. */
  deleteSelected(): boolean {
    const store = useSketchAnnotationStore();
    const i = store.dimSelected;
    const del = i === null ? undefined : store.dimItems[i]?.onDelete;
    if (!del) return false;
    store.dimSelected = null;
    del();
    return true;
  }
}

/** Resolve a label's presentation once. markRaw because every item carries
 *  commit/placeCommit/onDelete closures over SketchMode, plus THREE.Vector2
 *  anchors the drag mutates in place and the layer projects every frame. */
function present(d: DimLabel): DimItem {
  const fx = isFormula(d.expr);
  return markRaw<DimItem>({
    ...d,
    fx,
    text: fmtDim(d.valueMm, d.kind, d.driven, fx),
    cls: dimClass({ driven: d.driven, fx, conflict: d.conflict, over: d.over }),
    title: dimTitle({ driven: d.driven, fx, expr: d.expr }),
  });
}
