// The Project tool's click flow: pick a model edge, a body face (which projects
// its boundary), a whole body's silhouette, or a committed sketch curve, and
// land the result in the open sketch as linked "projected" entities.
//
// Split out of sketchMode.ts, following the ConstraintTools / PatternFlow /
// DimFlow precedent: ProjectHost below is a set of live accessors into
// SketchMode, never a copy, so nothing here can hold a stale entity list. That
// matters more here than anywhere else in the sketch, because projectClick
// AWAITS the sidecar: the sketch can be finished and a new one entered while a
// pick is in flight, and the session check at the end of that await only works
// because `entities()` reads the current array rather than one captured at
// construction.
//
// Every pick runs the projectGeometry aux-op against the timeline-PREFIX
// document (store.projectGeometry truncates), so a sketch can only project
// geometry that already existed when it was created.

import * as THREE from "three";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { EdgeFingerprint, Feature, ProjectedSource } from "../types";
import type { SketchPlane } from "./plane";
import type { SketchOverlay } from "./overlay";
import { curveObjects } from "./overlay";
import type { ProjectPanel } from "./projectPanel";
import type { SketchTool } from "./sketchMode";
import type { ResolvedEntity } from "./snap";
import { pickEntity } from "./modify";
import { newEntityId } from "./id";
import { resolveRealEntities } from "./resolve";
import { toast } from "../ui/toast";

// Tolerant edge-fingerprint compare for the Project tool's duplicate-pick check.
// Fingerprints carry unrounded float noise (sidecar-authored), so byte equality
// is meaningless — same midpoint (within 1e-3 mm), same unoriented tangent, and
// a matching length when both carry one, is "the same edge".
function fpClose(a: EdgeFingerprint, b: EdgeFingerprint): boolean {
  if (Math.hypot(a.mid[0] - b.mid[0], a.mid[1] - b.mid[1], a.mid[2] - b.mid[2]) > 1e-3) return false;
  const dot = Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]);
  if (dot < 1 - 1e-6) return false;
  if (a.length != null && b.length != null && Math.abs(a.length - b.length) > 1e-3) return false;
  return true;
}

/** The slice of SketchMode this flow reads/writes — live accessors, not copies. */
export interface ProjectHost {
  /** live entity list; the projected curves are pushed straight onto it */
  entities(): ResolvedEntity[];
  /** undefined until enter() runs; every pick needs it */
  store(): DocumentStore | undefined;
  overlay(): SketchOverlay;
  viewport(): Viewport;
  plane(): SketchPlane;
  /** the filter chips: edges & faces / body silhouette / sketch curves */
  projectPanel(): ProjectPanel;
  /** the sketch feature being edited, or null when this is a new one */
  editingId(): string | null;
  /** is the sketch still open? an awaited pick can outlive it */
  active(): boolean;
  tool(): SketchTool;
  /** pick radius in sketch mm at the current zoom */
  pickTol(): number;
  planePoint(e: MouseEvent): THREE.Vector2 | null;
  refreshActive(): void;
  requestSolve(): void;
  onState(): void;
}

export class ProjectFlow {
  // one pick at a time: projectClick awaits the sidecar, and a double-click
  // would otherwise race two ops against the same sketch
  private projectBusy = false;

  constructor(private readonly host: ProjectHost) {}

  // --- Project (Fusion-style): click 3D model edges, body faces (→ boundary),
  // or committed sketch curves; each pick calls the projectGeometry aux-op
  // against the timeline-PREFIX document (store.projectGeometry truncates) and
  // lands purple linked "projected" entities in the open sketch immediately. ---

  /** the committed sketch feature `id`, when it is a sketch */
  private sourceSketch(id: string): Extract<Feature, { type: "sketch" }> | null {
    const f = this.host.store()?.document.features.find((x) => x.id === id);
    return f && f.type === "sketch" ? f : null;
  }

  /** a committed sketch's REAL entity by id, with its owning sketch feature —
   *  derived pattern copies (ids carry "#") resolve to null: they don't exist
   *  in the document, so the sidecar could never re-find them. */
  private committedSource(
    sketchId: string,
    entityId: string,
  ): { sketch: Extract<Feature, { type: "sketch" }>; entity: ResolvedEntity } | null {
    const sk = this.sourceSketch(sketchId);
    const store = this.host.store();
    if (!sk || !store) return null;
    const entity = resolveRealEntities(sk, store.document.parameters).find((x) => x.id === entityId);
    return entity ? { sketch: sk, entity } : null;
  }

  /** hover feedback for the Project tool: model edge/face highlight in Edges &
   *  faces AND Body silhouette modes (the model is dimmed 0.25 in sketch view
   *  but still raycastable; there is no body-level hover in the viewport, so a
   *  silhouette pick hovers the face/edge that will resolve to its body); a
   *  committed curve highlight via the preview layer in Sketch curves mode. */
  projectHover(e: PointerEvent) {
    if (this.host.projectPanel().filter !== "sketchCurves") {
      this.host.overlay().setPreview([]);
      this.host.viewport().hoverEntity(this.host.viewport().pickEntity(e.clientX, e.clientY));
      return;
    }
    this.host.viewport().hoverEntity(null);
    const hit = this.host.overlay().committedCurveAt(e.clientX, e.clientY, (w) => this.host.viewport().projectToScreen(w));
    const src = hit ? this.committedSource(hit.sketchId, hit.entityId) : null;
    this.host.overlay().setPreview(
      src ? curveObjects([src.entity], this.host.overlay().planeFor(src.sketch.plane), 0x33aaff, true) : [],
    );
    this.host.viewport().requestRender();
  }

  /** does an already-placed projected entity carry (a match selector for) this
   *  edge fingerprint? Tolerant compare — fps carry float noise, never compare
   *  them byte-for-byte. */
  private hasProjectedFp(fp: EdgeFingerprint): boolean {
    return this.host.entities().some((x) => {
      if (x.type !== "projected") return false;
      const s = x.source;
      if (s.kind !== "edge" && s.kind !== "faceBoundary") return false;
      return s.sel.kind === "edge" && s.sel.by === "match" && fpClose(s.sel.fp, fp);
    });
  }

  /** One Project pick: resolve what's under the cursor into a ProjectedSource,
   *  run the op, land the returned curves as projected entities. Await-guarded
   *  by projectBusy so double-clicks can't race two calls. */
  async projectClick(e: PointerEvent) {
    const store = this.host.store();
    if (this.projectBusy || !store) return;
    let source: ProjectedSource | null = null;
    if (this.host.projectPanel().filter === "sketchCurves") {
      const hit = this.host.overlay().committedCurveAt(e.clientX, e.clientY, (w) => this.host.viewport().projectToScreen(w));
      if (!hit) {
        // nothing committed under the cursor — the ACTIVE sketch's own entities
        // are never valid sources (checked second: a projection usually lies
        // screen-coincident with its source, and the source must stay pickable)
        const p = this.host.planePoint(e);
        if (p && pickEntity(this.host.entities(), p, this.host.pickTol()) >= 0) toast("Can't project the active sketch's own curves");
        return;
      }
      if (!this.committedSource(hit.sketchId, hit.entityId)) {
        toast("Pattern copies can't be projected, pick the pattern's source curve");
        return;
      }
      const dup = this.host.entities().some(
        (x) =>
          x.type === "projected" &&
          x.source.kind === "sketchCurve" &&
          x.source.sketch === hit.sketchId &&
          x.source.entity === hit.entityId,
      );
      if (dup) {
        toast("That curve is already projected into this sketch");
        return;
      }
      source = { kind: "sketchCurve", sketch: hit.sketchId, entity: hit.entityId };
    } else {
      const hit = this.host.viewport().pickEntity(e.clientX, e.clientY);
      if (!hit) return;
      const body =
        hit.kind === "edge"
          ? hit.edge.body
          : this.host.viewport().faceIdToBodyId(hit.faceId);
      if (!body) return;
      if (this.host.projectPanel().filter === "silhouette") {
        // any face/edge hit resolves to its whole BODY — the HLR outline source
        const dup = this.host.entities().some(
          (x) => x.type === "projected" && x.source.kind === "silhouette" && x.source.body === body,
        );
        if (dup) {
          toast("That body's silhouette is already projected into this sketch");
          return;
        }
        source = { kind: "silhouette", body };
      } else if (hit.kind === "edge") {
        // NOT hit.selector: the picker's nearest point is the line's mid VERTEX,
        // which for a 2-point straight edge is an ENDPOINT — a corner shared by
        // three edges that "nearest" (center-distance) then resolves to the
        // wrong one. The middle segment's midpoint is on (or near) the curve
        // and never a corner.
        const pts = hit.edge.points;
        const k = Math.max(0, Math.ceil(pts.length / 2) - 1);
        const a = pts[k]!, b = pts[Math.min(pts.length - 1, k + 1)]!;
        source = {
          kind: "edge", body,
          sel: { kind: "edge", by: "nearest", point: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2] },
        };
      } else {
        // the raycast hit point re-finds exactly the clicked face: it lies ON
        // the face's material, so by:"nearest" distance is 0 there and > 0 for
        // every other face. NOT the face centroid (which can fall off the
        // material — a washer's annular face — and tie with another face), and
        // NOT the picker's own selector (may be a by:"normal" GROUP hit, too
        // broad for one face's boundary).
        source = { kind: "faceBoundary", body, sel: { kind: "face", by: "nearest", point: hit.point } };
      }
    }

    this.projectBusy = true;
    // Session identity: enter() always assigns a fresh entities array, so if the
    // sketch was finished and a NEW one started while the op was in flight (a
    // realistic window — cold-cache prefix rebuilds take seconds), the identity
    // check below rejects the stale reply instead of landing curves computed
    // against the old sketch's plane and timeline prefix.
    const session = this.host.entities();
    let results;
    try {
      results = await store.projectGeometry(this.host.plane().serialize(), [source], this.host.editingId());
    } finally {
      this.projectBusy = false;
    }
    if (!this.host.active() || this.host.tool() !== "project" || this.host.entities() !== session) return; // finished/switched/re-entered mid-flight
    const r = results[0];
    if (!r) {
      toast("geometry engine unavailable");
      return;
    }
    if (!r.ok) {
      toast(r.error ?? "projection failed"); // sidecar message verbatim ("created after this sketch"…)
      return;
    }
    // body-edge duplicates are detected against the returned fingerprints (the
    // sketch-curve case was pre-checked above — its ids are stable)
    const fresh = r.curves.filter(({ fp }) => !(fp && this.hasProjectedFp(fp)));
    const skipped = r.curves.length - fresh.length;
    if (skipped) toast(skipped === r.curves.length ? "That edge is already projected into this sketch" : `${skipped} already-projected edge${skipped > 1 ? "s" : ""} skipped`);
    if (!fresh.length) return;
    // multi-curve picks (a face boundary, a projected rectangle) emit sibling
    // entities sharing source.group = the FIRST sibling's entity id (stable:
    // entity ids are birth-stamped and survive edits)
    const ids = fresh.map(() => newEntityId());
    const group = ids.length > 1 ? { group: ids[0]! } : {};
    fresh.forEach(({ fp, curve }, i) => {
      // NOTE (plan step 4): a faceBoundary source persists with a per-edge
      // by:"match" sel — the rebuild refresh handler must resolve it via
      // resolve_edges (not resolve_faces) when it lands.
      const src: ProjectedSource =
        source.kind === "sketchCurve"
          ? // `index: i` is sound because sketch-curve results carry no fps, so
            // the dedup filter above never drops any — i IS the edge index in
            // the sidecar's deterministic _entity_edges order (the refresh
            // handler's authoritative sibling correspondence).
            { kind: "sketchCurve", sketch: source.sketch, entity: source.entity, ...group, ...(fresh.length > 1 ? { index: i } : {}) }
          : source.kind === "silhouette"
            ? // whole-body source: no selector; the refresh re-runs HLR and
              // re-matches the sibling curves (see _recompute_projections)
              { kind: "silhouette", body: source.body, ...group }
            : { kind: source.kind, body: source.body, sel: fp ? { kind: "edge", by: "match", fp } : source.sel, ...group };
      this.host.entities().push({ type: "projected", id: ids[i]!, source: src, curve });
    });
    this.host.refreshActive();
    this.host.requestSolve();
    this.host.onState();
  }
}
