// Editable dimension labels on committed sketch geometry (the "edit the length later" half), a facade over
// SketchDimLayer.vue and stores/sketchAnnotations.ts, which own the drag, the editor and per-frame reprojection.

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
  /** Driving expression when parameter-bound, the label renders `fx: <value>` when it is not a plain literal. */
  expr?: string;
  /** Gets the raw input (number or formula), returns an error or null. Formulas and edits on bound dims go here, a
   *  plain number on an unbound dim keeps `commit`, since non-bindable fields reject formulas. */
  commitExpr?: (raw: string) => string | null;
  /** Offset from the natural anchor in sketch mm, the basis a drag adds its delta to. Comes with `placeCommit`. */
  place?: THREE.Vector2;
  /** Sketch mm. While `done` is false the host must keep this label alive. Returns the recomputed anchor, which the
   *  label follows rather than the raw cursor so a perpendicular or radial dim never jumps on release. */
  placeCommit?: (ox: number, oy: number, done: boolean) => THREE.Vector2 | null;
  /** Only on constraint-backed dims. An entity dim (circle diameter, rect width) has no constraint, so its label
   *  shows the action disabled. */
  onDelete?: () => void;
}

/** valueMm is degrees when kind === "angle" */
export type ExtraDim = Omit<DimLabel, "suppressEdit">;

/** Resolved once at show() since nothing changes without a rebuild, leaving the component only per-frame work. */
export interface DimItem extends DimLabel {
  text: string;
  cls: string;
  title: string;
  fx: boolean;
}

export class SketchDimensions {
  /** A badge can sit on the entity it labels and swallow the click meant to select it. Returning true means
   *  geometry claimed the click, and the label skips its value edit. */
  onOverlapPick: ((e: PointerEvent) => boolean) | null = null;
  /** Screen px to sketch-plane mm through the real plane, correct on XZ, YZ or datum planes whose +Y differs from
   *  the screen's. Without it labels are not draggable. */
  onPlanePoint: ((clientX: number, clientY: number) => THREE.Vector2 | null) | null = null;
  /** Entity badges (rect W/H, circle diameter, slot L/W, ...) have no constraint, so placement lives on the entity.
   *  Same contract as DimLabel.placeCommit, `index` indexes the array passed to show(). */
  onEntityPlace:
    ((index: number, field: DimField, ox: number, oy: number, done: boolean) => THREE.Vector2 | null) | null = null;
  /** The owner renders the menu. `del` is null for an entity dim, which has nothing to delete. */
  onLabelMenu: ((e: MouseEvent, del: (() => void) | null) => void) | null = null;

  /** Read at call time since SketchMode assigns the hooks after construction, markRaw since they close over it. */
  private readonly hooks: DimHooks = markRaw({
    overlapPick: (e: PointerEvent) => this.onOverlapPick?.(e) ?? false,
    planePoint: (cx: number, cy: number) => this.onPlanePoint?.(cx, cy) ?? null,
    labelMenu: (e: MouseEvent, del: (() => void) | null) => this.onLabelMenu?.(e, del),
  });

  constructor(
    private viewport: Viewport,
    private onEdit: (index: number, field: DimField, mm: number) => void,
    /** When set, entity labels accept formulas too. */
    private onEditExpr?: (index: number, field: DimField, raw: string) => string | null,
    private entityExprOf?: (index: number, field: DimField) => string | undefined,
  ) {}

  /** `skip` holds `<entityId>:<field>` badges a constraint label stands in for. */
  show(entities: ResolvedEntity[], plane: SketchPlane, extras: ExtraDim[] = [], skip?: ReadonlySet<string>) {
    const items: DimItem[] = [];
    // Concentric circles fan their diameter badges out, the same call dimensionSegments makes so labels and lines agree.
    const defaults = staggeredDefaults(entities);
    entities.forEach((e, i) => {
      for (const d of entityDims(e, defaults.get(e.id))) {
        if (skip?.has(`${e.id}:${d.field}`)) continue;
        const expr = this.entityExprOf?.(i, d.field);
        const field = d.field;
        items.push(
          present({
            anchor: d.labelPos,
            valueMm: d.valueMm,
            commit: (mm) => this.onEdit(i, field, mm),
            place: d.place,
            placeCommit: (ox, oy, done) => this.onEntityPlace?.(i, field, ox, oy, done) ?? null,
            ...(this.onEditExpr ? { commitExpr: (raw: string) => this.onEditExpr!(i, field, raw) } : {}),
            ...(expr ? { expr } : {}),
          }),
        );
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

  /** Under a drawing tool labels stay visible but click-through, so one over a circle's center cannot swallow the
   *  pick. The dimension tool re-arms after every commit, so its labels stay live and labelOverlapDimension arbitrates. */
  setInteractive(on: boolean) {
    useSketchAnnotationStore().dimsPassive = !on;
  }

  clearSelection() {
    useSketchAnnotationStore().dimSelected = null;
  }

  /** False when nothing is selected or the label is an entity dim, so the caller falls through to its own Delete. */
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

/** markRaw: items carry closures over SketchMode and THREE.Vector2 anchors the drag mutates and the layer projects. */
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
