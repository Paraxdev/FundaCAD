// The Project tool's click flow: model edges, face boundaries, body silhouettes or committed sketch curves land as
// linked projected entities. ProjectHost reads live because projectClick awaits the engine and the sketch can change
// meanwhile. Picks run against the timeline-prefix document, so a sketch only projects geometry older than itself.

import * as THREE from "three";
import { asFeature } from "../types";
import type { Viewport } from "../viewport/viewport";
import type { DocumentStore } from "../document/store";
import type { EdgeFingerprint, Feature, ProjectedSource, Selector } from "../types";
import type { SketchPlane } from "./plane";
import type { SketchOverlay } from "./overlay";
import { curveObjects } from "./overlay";
import type { ProjectPanel } from "./projectPanel";
import type { SketchTool } from "./sketchMode";
import type { ResolvedEntity } from "./snap";
import { pickEntity } from "./modify";
import { newEntityId } from "./id";
import { resolveRealEntities } from "./resolve";
import { edgeProbePoint } from "./planeEdgePick";
import { toast } from "../ui/toast";

// Fingerprints carry engine float noise: same midpoint within 1e-3 mm, same unoriented tangent and matching length
// when both carry one is the same edge.
function fpClose(a: EdgeFingerprint, b: EdgeFingerprint): boolean {
  if (Math.hypot(a.mid[0] - b.mid[0], a.mid[1] - b.mid[1], a.mid[2] - b.mid[2]) > 1e-3) return false;
  const dot = Math.abs(a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2]);
  if (dot < 1 - 1e-6) return false;
  if (a.length != null && b.length != null && Math.abs(a.length - b.length) > 1e-3) return false;
  return true;
}

/** Live accessors, not copies. */
export interface ProjectHost {
  /** projected curves are pushed straight onto it */
  entities(): ResolvedEntity[];
  /** undefined until enter() runs */
  store(): DocumentStore | undefined;
  overlay(): SketchOverlay;
  viewport(): Viewport;
  plane(): SketchPlane;
  projectPanel(): ProjectPanel;
  /** null for a new sketch */
  editingId(): string | null;
  /** an awaited pick can outlive the sketch */
  active(): boolean;
  tool(): SketchTool;
  /** sketch mm at the current zoom */
  pickTol(): number;
  planePoint(e: MouseEvent): THREE.Vector2 | null;
  refreshActive(): void;
  requestSolve(): void;
  onState(): void;
}

export class ProjectFlow {
  // projectClick awaits the engine, a double-click would race two ops against the same sketch.
  private projectBusy = false;

  constructor(private readonly host: ProjectHost) {}

  private sourceSketch(id: string): Extract<Feature, { type: "sketch" }> | null {
    return asFeature(
      this.host.store()?.document.features.find((x) => x.id === id),
      "sketch",
    );
  }

  /** Derived pattern copies (ids with "#") resolve to null, the engine could never re-find them. */
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

  /** The model is dimmed in sketch view but still raycastable. The viewport has no body-level hover, so a silhouette
   *  pick hovers the face or edge that resolves to its body. */
  projectHover(e: PointerEvent) {
    if (this.host.projectPanel().filter !== "sketchCurves") {
      this.host.overlay().setPreview([]);
      this.host.viewport().hoverEntity(this.host.viewport().pickEntity(e.clientX, e.clientY));
      return;
    }
    this.host.viewport().hoverEntity(null);
    const hit = this.host
      .overlay()
      .committedCurveAt(e.clientX, e.clientY, (w) => this.host.viewport().projectToScreen(w));
    const src = hit ? this.committedSource(hit.sketchId, hit.entityId) : null;
    this.host
      .overlay()
      .setPreview(
        src ? curveObjects([src.entity], this.host.overlay().planeFor(src.sketch.plane), 0x33aaff, true) : [],
      );
    this.host.viewport().requestRender();
  }

  /** Tolerant compare, fingerprints carry float noise. */
  private projectedWithFp(fp: EdgeFingerprint): ResolvedEntity | undefined {
    return this.host.entities().find((x) => {
      if (x.type !== "projected") return false;
      const s = x.source;
      if (s.kind !== "edge" && s.kind !== "faceBoundary") return false;
      return s.sel.kind === "edge" && s.sel.by === "match" && fpClose(s.sel.fp, fp);
    });
  }
  private hasProjectedFp(fp: EdgeFingerprint): boolean {
    return !!this.projectedWithFp(fp);
  }

  /** For a tool that treats a face edge as a sketch curve. Per edge, the new or already projected entity ids, null
   *  when the engine refused or the sketch changed mid-op. No solve or notify: the caller banks one undo step. */
  async projectModelEdges(
    edges: readonly { body: string; points: readonly (readonly [number, number, number])[] }[],
  ): Promise<{ ids: string[][]; added: string[] } | null> {
    const store = this.host.store();
    if (this.projectBusy || !store || !edges.length) return null;
    const sources: { body: string; sel: Selector }[] = [];
    for (const e of edges) {
      const point = edgeProbePoint(e.points);
      if (!point) return null;
      sources.push({ body: e.body, sel: { kind: "edge", by: "nearest", point } });
    }
    this.projectBusy = true;
    const session = this.host.entities();
    let results;
    try {
      results = await store.projectGeometry(
        this.host.plane().serialize(),
        sources.map((s): ProjectedSource => ({ kind: "edge", ...s })),
        this.host.editingId(),
      );
    } finally {
      this.projectBusy = false;
    }
    if (!this.host.active() || this.host.entities() !== session) return null;
    const failed = sources.findIndex((_s, i) => !results[i]?.ok);
    if (failed >= 0) {
      toast(results[failed]?.error ?? "geometry engine unavailable");
      return null;
    }
    const ids: string[][] = [];
    const added: string[] = [];
    sources.forEach((source, i) => {
      const own: string[] = [];
      for (const { fp, curve } of results[i]!.curves) {
        const existing = fp ? this.projectedWithFp(fp) : undefined;
        if (existing) {
          own.push(existing.id);
          continue;
        }
        const id = newEntityId();
        const sel: Selector = fp ? { kind: "edge", by: "match", fp } : source.sel;
        this.host.entities().push({ type: "projected", id, source: { kind: "edge", body: source.body, sel }, curve });
        own.push(id);
        added.push(id);
      }
      ids.push(own);
    });
    return { ids, added };
  }

  async projectClick(e: PointerEvent) {
    const store = this.host.store();
    if (this.projectBusy || !store) return;
    let source: ProjectedSource | null = null;
    if (this.host.projectPanel().filter === "sketchCurves") {
      const hit = this.host
        .overlay()
        .committedCurveAt(e.clientX, e.clientY, (w) => this.host.viewport().projectToScreen(w));
      if (!hit) {
        // Committed curves only, never the active sketch's own. Checked second since a projection usually lies
        // screen-coincident with its source.
        const p = this.host.planePoint(e);
        if (p && pickEntity(this.host.entities(), p, this.host.pickTol()) >= 0)
          toast("Can't project the active sketch's own curves");
        return;
      }
      if (!this.committedSource(hit.sketchId, hit.entityId)) {
        toast("Pattern copies can't be projected, pick the pattern's source curve");
        return;
      }
      const dup = this.host
        .entities()
        .some(
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
      const body = hit.kind === "edge" ? hit.edge.body : this.host.viewport().faceIdToBodyId(hit.faceId);
      if (!body) return;
      if (this.host.projectPanel().filter === "silhouette") {
        // any face/edge hit resolves to its whole BODY, the HLR outline source
        const dup = this.host
          .entities()
          .some((x) => x.type === "projected" && x.source.kind === "silhouette" && x.source.body === body);
        if (dup) {
          toast("That body's silhouette is already projected into this sketch");
          return;
        }
        source = { kind: "silhouette", body };
      } else if (hit.kind === "edge") {
        // NOT hit.selector: the picker's nearest point is the line's mid VERTEX,
        // an endpoint on a straight edge, see edgeProbePoint.
        const point = edgeProbePoint(hit.edge.points);
        if (!point) return;
        source = { kind: "edge", body, sel: { kind: "edge", by: "nearest", point } };
      } else {
        // The raycast hit lies on the clicked face's material, so by:"nearest" re-finds exactly it. Not the centroid (can
        // fall off a washer's face), not the picker's selector (may be a broad by:"normal" group).
        source = { kind: "faceBoundary", body, sel: { kind: "face", by: "nearest", point: hit.point } };
      }
    }

    this.projectBusy = true;
    // enter() assigns a fresh entities array, so the identity check below rejects a reply that lands after the sketch
    // was finished and a new one started (cold prefix rebuilds take seconds).
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
      toast(r.error ?? "projection failed"); // engine message verbatim ("created after this sketch"…)
      return;
    }
    // Sketch-curve duplicates were pre-checked above, body edges are checked against the returned fingerprints.
    const fresh = r.curves.filter(({ fp }) => !(fp && this.hasProjectedFp(fp)));
    const skipped = r.curves.length - fresh.length;
    if (skipped)
      toast(
        skipped === r.curves.length
          ? "That edge is already projected into this sketch"
          : `${skipped} already-projected edge${skipped > 1 ? "s" : ""} skipped`,
      );
    if (!fresh.length) return;
    // Multi-curve picks emit siblings sharing source.group, the first sibling's birth-stamped entity id.
    const ids = fresh.map(() => newEntityId());
    const group = ids.length > 1 ? { group: ids[0]! } : {};
    fresh.forEach(({ fp, curve }, i) => {
      // A faceBoundary source persists a per-edge by:"match" sel, so the refresh must resolve it via resolve_edges.
      const src: ProjectedSource =
        source.kind === "sketchCurve"
          ? // `index: i` is sound: sketch-curve results carry no fps so none are dropped, i is the _entity_edges index.
            {
              kind: "sketchCurve",
              sketch: source.sketch,
              entity: source.entity,
              ...group,
              ...(fresh.length > 1 ? { index: i } : {}),
            }
          : source.kind === "silhouette"
            ? // whole-body source: the refresh re-runs HLR and re-matches the siblings (see _recompute_projections)
              { kind: "silhouette", body: source.body, ...group }
            : {
                kind: source.kind,
                body: source.body,
                sel: fp ? { kind: "edge", by: "match", fp } : source.sel,
                ...group,
              };
      this.host.entities().push({ type: "projected", id: ids[i]!, source: src, curve });
    });
    this.host.refreshActive();
    this.host.requestSolve();
    this.host.onState();
  }
}
