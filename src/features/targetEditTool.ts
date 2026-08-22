// Editing what a feature is applied to: the set of edges, faces or bodies it
// acts on, opened from the Properties row that shows it.
//
// The gesture is the one every other picking tool in the app already uses —
// click geometry to toggle it in or out — with two things the others do not
// have: the running set is a LIST you can read, and each entry can be pointed at
// and removed on its own. That is the difference between "pick again and hope"
// and "this one, the third, take it off".
//
// THE ROLLBACK IS THE WHOLE TRICK. A committed fillet has already eaten its own
// member edges: they are not on the model any more, so there is nothing to
// highlight and nothing to click. store.beginEditPreview truncates the timeline
// to just before this feature, which puts the sharp edges back on screen — the
// same arrangement edgeFeatureTool and textureTool use to re-open a blend or a
// texture, and for the same reason. Every later feature is hidden for the
// duration, and the panel says so.
//
// Selectors are NOT re-minted from what the rollback happens to render. An entry
// that still matches a rendered edge gets a highlight; one that does not is kept
// exactly as it was saved and carried through the commit untouched. The sidecar
// resolves `by:"nearest"` against the real geometry, which is a better matcher
// than this one, so a point this tool cannot place on screen is not evidence
// that the sidecar cannot place it either. Dropping such an entry would silently
// delete part of a working feature.
//
// The panel is a plain reader: it subscribes, renders `entries`, and calls back.
// No document state lives in it.

import type { Viewport } from "../viewport/viewport";
import type { EdgeRef } from "../viewport/edgeLines";
import type { DocumentStore } from "../document/store";
import type { Selector } from "../types";
import { setPrompt } from "../ui/prompt";
import {
  pointOf,
  readTarget,
  sameEntry,
  writeTarget,
  type TargetEntry,
  type TargetField,
} from "./selectionTargets";

/** One row of the list. `resolved` is false for an entry this tool could not put
 *  on screen — kept, carried through, and drawn greyed rather than hidden, so a
 *  set of four never silently reads as three. */
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

  // --- what the panel reads ---------------------------------------------------

  private listeners = new Set<() => void>();
  /** Subscribe to every change of the list; returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  /** The feature being edited, for the panel's title. */
  get editingId(): string | null {
    return this.featureId;
  }

  /** The target being edited, for the panel's heading. */
  get field(): TargetField | null {
    return this.target;
  }

  /** The list, in document order. */
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

  // --- starting and stopping --------------------------------------------------

  /** Open the editor on one target of one feature. Returns false when the
   *  feature is gone or another tool owns the screen. */
  start(featureId: string, target: TargetField, onDone?: (committed: boolean) => void): boolean {
    if (this.active) return false;
    // This editor picks on the SOLID. A profile area is an interior point on a
    // sketch plane and there is nothing here that can click one, so refusing is
    // the honest answer — the row for such a target opens the feature's own tool
    // instead (features/selectionTargets says why).
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
    // Capture phase, like edgeFeatureTool's: the viewport's own pick handler is
    // on the same element and would otherwise run first and re-select underneath
    // this tool's set.
    el.addEventListener("pointerdown", this.boundDown, true);
    window.addEventListener("keydown", this.boundKey, true);
    setPrompt("Rolling back to edit…");

    // Roll to just before the feature, then paint the saved entries onto the
    // model that comes back.
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

  /** Write the edited set back and close. */
  commit() {
    const id = this.featureId;
    const t = this.target;
    if (!this.active || !id || !t) return;
    const patch = writeTarget(t, this.entries);
    this.cleanup();
    // endEditPreview BEFORE the write, so the rebuild the write schedules is the
    // one that builds the whole timeline back — the same order extrudeTool's
    // commit uses.
    this.store.endEditPreview(false);
    this.store.updateFeature(id, patch);
    this.onDone?.(true);
    this.onDone = null;
  }

  /** Close, changing nothing. */
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

  // --- editing the set --------------------------------------------------------

  /** Drop the entry at `index`. */
  removeAt(index: number) {
    if (!this.active || index < 0 || index >= this.entries.length) return;
    this.entries.splice(index, 1);
    this.repaint();
    this.setPrompt();
    this.emit();
  }

  /** Drop them all. The feature is left with an empty target, which for several
   *  of them is a legal and meaningful state (a sealed shell, a whole-body
   *  texture) — see selectionTargets.whenEmpty. */
  clear() {
    if (!this.active || !this.entries.length) return;
    this.entries = [];
    this.repaint();
    this.setPrompt();
    this.emit();
  }

  /** Point at one entry without changing anything: the viewport highlights the
   *  geometry it names. Pass null to stop. */
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
    // The entry IS a selector, so the Hit is assembled from it rather than
    // re-derived: hoverEntity wants a full hit, and minting a second selector
    // for the same geometry is a second chance to name something else.
    const sel = selectorOf(entry);
    if (found.kind === "edge" && sel) {
      this.viewport.hoverEntity({ kind: "edge", edge: found.edge, selector: sel });
    } else if (found.kind === "face" && sel) {
      const p = pointOf(sel);
      if (p) this.viewport.hoverEntity({ kind: "face", faceId: found.faceId, selector: sel, point: p });
    }
    // A body has no hover form of its own; it is already painted as selected.
  }

  // --- picking ----------------------------------------------------------------

  private onDown(e: PointerEvent) {
    if (!this.active || e.button !== 0 || this.awaitingRollback) return;
    const t = this.target;
    if (!t) return;
    const entry = this.pickAt(e.clientX, e.clientY, t);
    if (!entry) return; // a click on nothing is not a change
    e.preventDefault();
    e.stopPropagation();
    this.toggle(entry, t);
  }

  /** What is under the cursor, as an entry of this target's kind. Null when the
   *  click landed on nothing, or on something of the wrong kind — clicking a
   *  face while editing an edge set must do nothing rather than something
   *  surprising.
   *
   *  The EDGE selector is the pick's own, which viewport/picking.ts already
   *  minted through edgeSelectorFrom — the one path that stamps the owning body,
   *  without which the sidecar falls back to the active body and blends an edge
   *  of the wrong one with no error at all.
   *
   *  The FACE selector is not. A pick prefers `by:"normal"` on an axis-aligned
   *  face, which names EVERY face pointing that way; that is the right default
   *  for a press-pull, and quite wrong for a list where each row is meant to be
   *  one face you can point at and take off. So this mints a `by:"nearest"` from
   *  the hit POINT — which picking.ts guarantees is on the face's material,
   *  unlike its centroid on an annular one. */
  private pickAt(x: number, y: number, t: TargetField): TargetEntry | null {
    if (t.kind === "body") return this.viewport.bodyIdAt(x, y);
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

  // --- painting ---------------------------------------------------------------

  /** Show the whole set on the model, from scratch. Cheap, and from scratch on
   *  purpose: an incremental paint has to agree with the list about what changed,
   *  and the two disagreeing is a highlight left behind on an edge that is no
   *  longer in the set. */
  private repaint() {
    const t = this.target;
    if (!t) return;
    this.viewport.clearSelection();
    if (t.kind === "body") {
      this.viewport.setSelectionMode("bodies");
      this.viewport.setSelectedBodies(
        this.entries.filter((e): e is string => typeof e === "string"),
      );
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

  /** Where an entry is on the CURRENT model, or null when it names nothing this
   *  build renders. Null is a display fact, never a reason to drop it — see the
   *  header. */
  private locate(entry: TargetEntry):
    | { kind: "edge"; edge: EdgeRef }
    | { kind: "face"; faceId: number }
    | { kind: "body"; id: string }
    | null {
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
    if (!p) return null; // by:"all", by:"axis", a v2 fingerprint — no single spot
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
      const body = (this.store.buildState.result?.bodies ?? []).find((b) => b.id === entry);
      return this.store.bodyName(entry) ?? body?.name ?? entry;
    }
    // Edges and faces have no names, so the row says what it is and whether it
    // could be found. "1 edge" per row is what the count above it is made of.
    return resolved ? `1 ${t.kind}` : `1 ${t.kind} (not on this build)`;
  }

  // --- prompt -----------------------------------------------------------------

  private setPrompt() {
    const t = this.target;
    if (!t) return;
    const n = this.entries.length;
    const noun = n === 1 ? t.kind : `${t.kind}s`;
    setPrompt(
      `${n} ${noun} · click one to add or remove · later features are hidden while editing · Enter · Esc`,
    );
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

/** The feature this tool is editing, if any — for the callers that need to know
 *  which row is open without reaching into the tool. */
export function editingTarget(tool: TargetEditTool): { id: string; field: string } | null {
  const id = tool.editingId;
  const f = tool.field;
  return id && f ? { id, field: f.field } : null;
}

/** The entry as a Selector, or null when it is one of the other two shapes.
 *  A body id is a string and a profile point is an array, so the narrowing is a
 *  pair of checks rather than a cast. */
function selectorOf(entry: TargetEntry): Selector | null {
  if (typeof entry === "string" || Array.isArray(entry)) return null;
  return entry;
}
