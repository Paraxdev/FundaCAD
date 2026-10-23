// Edits the edges, faces or bodies a feature acts on, opened from its Properties row.

import type { Viewport } from "../viewport/viewport";
import type { EdgeRef } from "../viewport/edgeLines";
import type { DocumentStore } from "../document/store";
import type { Selector } from "../types";
import { bodyLabels } from "../ui/bodyLabels";
import { setPrompt } from "../ui/prompt";
import { trackedFace } from "./holeFace";
import { pointOf, readTarget, sameEntry, writeTarget, type TargetEntry, type TargetField } from "./selectionTargets";

// `resolved` is false for an entry this build does not show; it is kept and drawn greyed,
// so a set of four never reads as three.
export interface TargetRow {
  entry: TargetEntry;
  label: string;
  resolved: boolean;
}

export class TargetEditTool {
  active = false;

  private featureId: string | null = null;
  private target: TargetField | null = null;
  private entries: TargetEntry[] = [];
  private onDone: ((committed: boolean) => void) | null = null;
  private unsubBuild: (() => void) | null = null;
  private awaitingRollback = false;
  private prevSelectionMode: "faces" | "bodies" = "faces";

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
      return {
        entry,
        label: this.labelFor(entry, found !== null),
        resolved: found !== null,
      };
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
    return { kind: "face", by: "nearest", point: hit.point } as Selector;
  }

  private toggle(entry: TargetEntry, t: TargetField) {
    const i = this.entries.findIndex((e) => sameEntry(e, entry));
    if (i >= 0) this.entries.splice(i, 1);
    else if (t.arity === "one") this.entries = [entry];
    else this.entries.push(entry);
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
  private locate(
    entry: TargetEntry,
  ): { kind: "edge"; edge: EdgeRef } | { kind: "face"; faceId: number } | { kind: "body"; id: string } | null {
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
    const faceId = this.viewport.faceIdNear(p);
    return faceId === null ? null : { kind: "face", faceId };
  }

  private labelFor(entry: TargetEntry, resolved: boolean): string {
    const t = this.target;
    if (!t) return "";
    if (t.kind === "body" && typeof entry === "string") {
      const built = this.store.buildState.result?.bodies ?? [];
      return bodyLabels(built, (id) => this.store.bodyName(id)).get(entry) ?? this.store.bodyName(entry) ?? entry;
    }
    // Edges and faces have no names, so a row says its kind and whether this build shows it.
    return resolved ? `1 ${t.kind}` : `1 ${t.kind} (not on this build)`;
  }

  private setPrompt() {
    const t = this.target;
    if (!t) return;
    const n = this.entries.length;
    const noun = n === 1 ? t.kind : `${t.kind}s`;
    setPrompt(`${n} ${noun} · click one to add or remove · later features are hidden while editing · Enter · Esc`);
  }

  private onKey(e: KeyboardEvent) {
    if (!this.active) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.cancel();
    } else if (e.key === "Enter") {
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

function selectorOf(entry: TargetEntry): Selector | null {
  if (typeof entry === "string" || Array.isArray(entry)) return null;
  return entry;
}
