// Edits the edges, faces or bodies a feature acts on, opened from its Properties row.

import type { Viewport } from "../viewport/viewport";
import type { EdgeRef } from "../viewport/edgeLines";
import type { DocumentStore } from "../document/store";
import type { Selector } from "../types";
import { bodyLabels } from "../ui/bodyLabels";
import { escapeClaimed } from "../ui/escapeClaim";
import { isMenuKey, keyTargetFree } from "../ui/focus";
import { setPrompt } from "../ui/prompt";
import { awaitTreePick, treePickRefusal, type TreePick, type TreePickAnswer } from "../ui/treePick";
import { edgeSelectorFrom, polylineMid } from "../viewport/edgeMatch";
import { trackedFace } from "./holeFace";
import { pointOf, readTarget, sameEntry, writeTarget, type TargetEntry, type TargetField } from "./selectionTargets";

// `resolved` is false for an entry this build does not show; it is kept and drawn greyed,
// so a set of four never reads as three.
export interface TargetRow {
  entry: TargetEntry;
  label: string;
  resolved: boolean;
}

const STILL_BUILDING = "The model is still building";
// An edge row counts only if the rolled back model has an edge this close, a row listed before the roll back has none.
const SAME_EDGE = 0.01;

export class TargetEditTool {
  active = false;

  private featureId: string | null = null;
  private target: TargetField | null = null;
  private entries: TargetEntry[] = [];
  private onDone: ((committed: boolean) => void) | null = null;
  private unsubBuild: (() => void) | null = null;
  private awaitingRollback = false;
  private releaseRows: (() => void) | null = null;
  private prevSelectionMode: "faces" | "bodies" = "faces";
  private inRun = false;
  private ranDirty = false;

  private boundDown: (e: PointerEvent) => void;
  private boundKey: (e: KeyboardEvent) => void;

  constructor(
    private viewport: Viewport,
    private store: DocumentStore,
  ) {
    this.boundDown = (e) => this.onDown(e);
    this.boundKey = (e) => this.onKey(e);
  }

  private listeners = new Set<() => void>();
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  get editingId(): string | null {
    return this.featureId;
  }

  get field(): TargetField | null {
    return this.target;
  }

  rows(): TargetRow[] {
    const t = this.target;
    if (!t) return [];
    return this.entries.map((entry) => {
      const found = this.locate(entry);
      return { entry, label: this.labelFor(entry, found), resolved: found !== null };
    });
  }

  /** Returns false when the feature is gone or another tool owns the screen. */
  start(featureId: string, target: TargetField, onDone?: (committed: boolean) => void): boolean {
    if (this.active) return false;
    // This picks on the solid and cannot click a profile area on a sketch plane;
    // such a row opens the feature's own tool instead (see selectionTargets).
    if (target.shape === "regionPoint") return false;
    const f = this.store.document.features.find((x) => x.id === featureId);
    if (!f) return false;

    this.active = true;
    this.featureId = featureId;
    this.target = target;
    this.entries = readTarget(f, target);
    this.onDone = onDone ?? null;
    this.awaitingRollback = true;

    this.prevSelectionMode = this.viewport.selecting;
    this.viewport.suspendPicking = true;
    if (target.kind === "edge") this.viewport.emphasizeEdges(true);
    const el = this.viewport.domElement;
    // Capture phase, or the viewport's own pick handler on the same element runs first
    // and reselects underneath this tool's set.
    el.addEventListener("pointerdown", this.boundDown, true);
    window.addEventListener("keydown", this.boundKey, true);
    this.releaseRows = awaitTreePick(
      (pick) => this.takeRow(pick),
      () => this.cancel(),
      {
        keepsOnRewind: true,
        keepsOnCommand: true,
        batch: (run) => this.takeRun(run),
      },
    );
    setPrompt("Rolling back to edit…");

    // A committed fillet has eaten its own edges, so roll back to just before the
    // feature to put them on screen again, as edgeFeatureTool does to reopen a blend.
    this.store.beginEditPreview(featureId);
    this.unsubBuild = this.store.onBuild((s) => {
      if (s.building || !s.result) return;
      if (!this.awaitingRollback) return;
      this.awaitingRollback = false;
      this.repaint();
      this.setPrompt();
      this.emit();
    });
    this.emit();
    return true;
  }

  commit() {
    const id = this.featureId;
    const t = this.target;
    if (!this.active || !id || !t) return;
    const patch = writeTarget(t, this.entries);
    this.cleanup();
    // endEditPreview before the write, so the write's rebuild is the one that
    // restores the whole timeline.
    this.store.endEditPreview(false);
    this.store.updateFeature(id, patch);
    this.onDone?.(true);
    this.onDone = null;
  }

  cancel() {
    if (!this.active) return;
    this.cleanup();
    this.store.endEditPreview(true);
    this.onDone?.(false);
    this.onDone = null;
  }

  private cleanup() {
    this.active = false;
    this.unsubBuild?.();
    this.unsubBuild = null;
    const el = this.viewport.domElement;
    el.removeEventListener("pointerdown", this.boundDown, true);
    window.removeEventListener("keydown", this.boundKey, true);
    this.releaseRows?.();
    this.releaseRows = null;
    this.viewport.suspendPicking = false;
    if (this.target?.kind === "edge") this.viewport.emphasizeEdges(false);
    this.viewport.clearSelection();
    this.viewport.setSelectionMode(this.prevSelectionMode);
    this.viewport.hoverEntity(null);
    setPrompt(null);
    this.featureId = null;
    this.target = null;
    this.entries = [];
    this.emit();
  }

  removeAt(index: number) {
    if (!this.active || index < 0 || index >= this.entries.length) return;
    this.entries.splice(index, 1);
    this.repaint();
    this.setPrompt();
    this.emit();
  }

  // An empty target is legal for several features (a sealed shell, a whole-body texture),
  // see selectionTargets.whenEmpty.
  clear() {
    if (!this.active || !this.entries.length) return;
    this.entries = [];
    this.repaint();
    this.setPrompt();
    this.emit();
  }

  hoverAt(index: number | null) {
    if (!this.active) return;
    const entry = index === null ? undefined : this.entries[index];
    if (entry === undefined) {
      this.viewport.hoverEntity(null);
      return;
    }
    const found = this.locate(entry);
    if (!found) {
      this.viewport.hoverEntity(null);
      return;
    }
    // The Hit is built from the entry's own selector, since minting a second one for
    // the same geometry is a second chance to name something else.
    const sel = selectorOf(entry);
    if (found.kind === "edge" && sel) {
      this.viewport.hoverEntity({ kind: "edge", edge: found.edge, selector: sel });
    } else if (found.kind === "face" && sel) {
      const p = pointOf(sel);
      if (p) this.viewport.hoverEntity({ kind: "face", faceId: found.faceId, selector: sel, point: p });
    }
    // A body has no hover form of its own; it is already painted as selected.
  }

  private onDown(e: PointerEvent) {
    if (!this.active || e.button !== 0 || this.awaitingRollback) return;
    const t = this.target;
    if (!t) return;
    const entry = this.pickAt(e.clientX, e.clientY, t);
    if (!entry) return;
    e.preventDefault();
    e.stopPropagation();
    this.toggle(entry, t);
  }

  private takeRow(pick: TreePick): TreePickAnswer {
    const t = this.target;
    if (!t || this.awaitingRollback) return STILL_BUILDING;
    if (t.kind === "body") return this.takeBodyRow(pick, t);
    if (t.kind === "face") return this.takeFaceRow(pick, t);
    if (pick.kind !== "edge") return treePickRefusal(pick, "an edge");
    const sel = edgeSelectorFrom(pick.edge);
    const mid = polylineMid(pick.edge.points);
    const there = mid && this.viewport.edgeLineByMid(mid);
    const at = there && polylineMid(there.points);
    if (!sel || !mid || !at || Math.hypot(at[0] - mid[0], at[1] - mid[1], at[2] - mid[2]) > SAME_EDGE) {
      return "That edge is not on the model this feature edits";
    }
    this.toggle(sel, t);
    return true;
  }

  // The Geometry list follows the roll back, so a face row numbers a face of the model this feature edits.
  private takeFaceRow(pick: TreePick, t: TargetField): TreePickAnswer {
    if (pick.kind !== "face") return treePickRefusal(pick, "a face");
    if (t.tracked) {
      const at = this.viewport.facesForPressPull([pick.faceId]);
      if (!at) return STILL_BUILDING;
      const { anchor: a, normal: n } = at;
      this.toggle(trackedFace([a.x, a.y, a.z], [n.x, n.y, n.z], at.bodyId), t);
      return true;
    }
    const { body, ...plain } = this.viewport.faceSelectorOf(pick.faceId) as Selector & { body?: string };
    this.toggle(t.ownBody && body ? { ...plain, body } : plain, t);
    return true;
  }

  private takeBodyRow(pick: TreePick, t: TargetField): TreePickAnswer {
    if (pick.kind !== "body" && pick.kind !== "bodies") return treePickRefusal(pick, "a body");
    const ids = pick.kind === "body" ? [pick.id] : pick.ids;
    if (t.arity === "one" && ids.length !== 1) return "This takes one body";
    const built = this.store.buildState.result?.bodies ?? [];
    if (!ids.length || !ids.every((id) => built.some((b) => b.id === id))) {
      return "That body is not in the model this feature edits";
    }
    const missing = ids.filter((id) => !this.entries.includes(id));
    // A folder row adds what is missing, and takes them all out only when all are in.
    for (const id of missing.length ? missing : ids) this.toggle(id, t);
    return true;
  }

  // Null on a hit of the wrong kind. Edges keep the pick's selector, the only path that
  // stamps the owning body; without it the engine blends an edge of the active body.
  // Faces get by:"nearest" from the hit point, since a pick's by:"normal" names every
  // face pointing that way, and the hit point lies on material unlike an annulus centroid.
  private pickAt(x: number, y: number, t: TargetField): TargetEntry | null {
    if (t.kind === "body") return this.viewport.bodyIdAt(x, y);
    if (t.kind === "face" && t.tracked) {
      const at = this.viewport.pickFaceForPressPull(x, y);
      if (!at) return null;
      const { anchor: a, normal: n } = at;
      return trackedFace([a.x, a.y, a.z], [n.x, n.y, n.z], at.bodyId);
    }
    const hit = this.viewport.pickEntity(x, y);
    if (!hit) return null;
    if (t.kind === "edge") return hit.kind === "edge" ? hit.selector : null;
    if (hit.kind !== "face") return null;
    const body = t.ownBody ? this.viewport.faceIdToBodyId(hit.faceId) : null;
    return { kind: "face", by: "nearest", point: hit.point, ...(body ? { body } : {}) } as Selector;
  }

  // A paint locates every entry again, a scan of the whole body per face, so a run of list rows paints once at its end.
  private takeRun(run: () => void) {
    this.inRun = true;
    try {
      run();
    } finally {
      this.inRun = false;
      if (this.ranDirty) this.changed();
    }
  }

  private toggle(entry: TargetEntry, t: TargetField) {
    const i = this.entries.findIndex((e) => sameEntry(e, entry));
    if (i >= 0) this.entries.splice(i, 1);
    else if (t.arity === "one") this.entries = [entry];
    else this.entries.push(entry);
    if (this.inRun) this.ranDirty = true;
    else this.changed();
  }

  private changed() {
    this.ranDirty = false;
    this.repaint();
    this.setPrompt();
    this.emit();
  }

  // From scratch on purpose: an incremental paint that disagrees with the list leaves
  // a highlight on an edge no longer in the set.
  private repaint() {
    const t = this.target;
    if (!t) return;
    this.viewport.clearSelection();
    if (t.kind === "body") {
      this.viewport.setSelectionMode("bodies");
      this.viewport.setSelectedBodies(this.entries.filter((e): e is string => typeof e === "string"));
      return;
    }
    this.viewport.setSelectionMode("faces");
    const edges: EdgeRef[] = [];
    const faces: number[] = [];
    for (const entry of this.entries) {
      const found = this.locate(entry);
      if (!found) continue;
      if (found.kind === "edge") edges.push(found.edge);
      else if (found.kind === "face") faces.push(found.faceId);
    }
    if (edges.length) this.viewport.selectEdgeLines(edges);
    if (faces.length) this.viewport.selectFaces(faces);
  }

  // Null only means this rolled back build does not render it, never a reason to drop it:
  // the engine's by:"nearest" matches real geometry better and may still place it.
  private locate(entry: TargetEntry): Found | null {
    const t = this.target;
    if (!t) return null;
    if (t.kind === "body") {
      if (typeof entry !== "string") return null;
      const known = (this.store.buildState.result?.bodies ?? []).some((b) => b.id === entry);
      return known ? { kind: "body", id: entry } : null;
    }
    const sel = selectorOf(entry);
    if (!sel) return null;
    const p = pointOf(sel);
    // by:"all", by:"axis" and v2 fingerprints have no single spot.
    if (!p) return null;
    if (t.kind === "edge") {
      const edge = this.viewport.edgeLineByMid(p);
      return edge ? { kind: "edge", edge } : null;
    }
    const faceId = this.viewport.faceIdNear(p, 0, sel.body);
    return faceId === null ? null : { kind: "face", faceId };
  }

  private labelFor(entry: TargetEntry, found: Found | null): string {
    const t = this.target;
    if (!t) return "";
    if (t.kind === "body" && typeof entry === "string") return this.bodyLabel(entry) ?? entry;
    if (found?.kind === "face") {
      const n = this.viewport.localFaceOf(found.faceId);
      const body = this.viewport.faceIdToBodyId(found.faceId);
      return ofBody(n === null ? "Face" : `Face ${n + 1}`, body && this.bodyLabel(body));
    }
    if (found?.kind === "edge") {
      return ofBody(`Edge ${found.edge.slot + 1}`, found.edge.body && this.bodyLabel(found.edge.body));
    }
    return t.kind === "body" ? "" : `${t.kind === "edge" ? "Edge" : "Face"} not on this build`;
  }

  private bodyLabel(id: string): string | undefined {
    const built = this.store.buildState.result?.bodies ?? [];
    return bodyLabels(built, (b) => this.store.bodyName(b)).get(id) ?? this.store.bodyName(id);
  }

  private setPrompt() {
    const t = this.target;
    if (!t) return;
    const n = this.entries.length;
    const noun = n === 1 ? t.kind : `${t.kind}s`;
    setPrompt(`${n} ${noun} · click one to add or remove · later features are hidden while editing · Enter · Esc`);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.active || isMenuKey(e) || (e.key === "Escape" && escapeClaimed())) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    } else if (e.key === "Enter" && keyTargetFree(e.target)) {
      e.preventDefault();
      e.stopPropagation();
      this.commit();
    }
  }
}

export function editingTarget(tool: TargetEditTool): { id: string; field: string } | null {
  const id = tool.editingId;
  const f = tool.field;
  return id && f ? { id, field: f.field } : null;
}

type Found = { kind: "edge"; edge: EdgeRef } | { kind: "face"; faceId: number } | { kind: "body"; id: string };

const ofBody = (what: string, body: string | undefined | null) => (body ? `${what} of ${body}` : what);

function selectorOf(entry: TargetEntry): Selector | null {
  if (typeof entry === "string" || Array.isArray(entry)) return null;
  return entry;
}
