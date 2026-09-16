// Pattern placement/edit flow: click to place, drag to size, type counts, click
// to commit. Each pattern persists as an editable (associative) definition,
// entity patterns (rect/circular) replicate the current selection, presets emit
// holes. Operates through the PatternHost accessor SketchMode provides, the
// pending/center/edit-original state below is this collaborator's own (moved
// out of SketchMode entirely), everything else is a live reference back into it.

import * as THREE from "three";
import type { SketchPattern } from "../types";
import type { DimInput } from "./dimInput";
import { newPatternId } from "./id";
import { nearCentreDot, patternSweepDeg, selectionCentre, snapAngleDeg } from "./patternDrag";
import { setPrompt } from "../ui/prompt";
import type { SketchTool } from "./sketchMode";

// preset hole patterns: self-contained (click a center, no source selection)
export const PRESET_PATTERNS = new Set<SketchTool>(["hexHoles", "honeycomb", "boltCircle", "gridHoles"]);
// patterns that replicate the current selection (MCAD-style)
export const ENTITY_PATTERNS = new Set<SketchTool>(["patternRect", "patternCircular"]);
// every pattern tool (presets + entity patterns)
export const PATTERN_TOOLS = new Set<SketchTool>([...PRESET_PATTERNS, ...ENTITY_PATTERNS]);

/** The slice of SketchMode this flow reads/writes, live accessors, not copies. */
export interface PatternHost {
  /** current active sketch tool (which pattern is being placed) */
  tool(): SketchTool;
  /** raw tool assignment, bypassing setTool()'s reset side-effects, editPattern
   *  needs the active tool switched to match the pattern being edited without
   *  wiping the placement state it just set up */
  setActiveTool(t: SketchTool): void;
  /** the full tool switch (used once placement commits, to return to "select") */
  setTool(t: SketchTool): void;
  /** live multi-selection, never copied */
  selected(): Set<string>;
  /** live pattern list, never copied; placement/edit push/splice it directly */
  patterns(): SketchPattern[];
  /** the shared on-canvas dimension input */
  dim(): DimInput;
  /** where a source entity sits, its centre or anchor, null if the id is gone */
  sourcePoint(id: string): { x: number; y: number } | null;
  /** the choke point in-sketch undo banks a step at, so a pattern that appears
   *  or disappears is a step the user can take back like any drawn entity */
  requestSolve(): void;
  /** a sketch point in client pixels, null when it does not project */
  toScreen(x: number, y: number): { x: number; y: number } | null;
  /** draw (or with null, clear) the draggable centre dot of a circular pattern */
  showCentreDot(p: { x: number; y: number } | null): void;
  refreshActive(): void;
  onState(): void;
}

export class PatternFlow {
  private pendingPattern: SketchPattern | null = null; // one being placed (live)
  private patternCenter: THREE.Vector2 | null = null; // its center (first click)
  private editOriginal: SketchPattern | null = null; // when editing, the pre-edit copy (Esc restores)
  private sweep: number | null = null; // circular pattern: the last angle the drag reported (null = drag not started)
  private centreDrag = false;

  constructor(private host: PatternHost) {}

  /** the pattern currently being placed/edited (live), for preview/derivedEntities */
  get pending(): SketchPattern | null {
    return this.pendingPattern;
  }
  hasPending(): boolean {
    return this.pendingPattern != null;
  }

  /** fresh sketch session: drop any placement state (mirrors enter()'s original
   *  scope, editOriginal is intentionally left alone, as before: it's always
   *  overwritten before it's next read, by editPattern()). */
  resetForEnter() {
    this.pendingPattern = null;
    this.patternCenter = null;
    this.sweep = null;
    this.centreDrag = false;
    this.syncDot();
  }

  /** push any in-progress pattern into the committed list, nulling only the
   *  pending pattern itself (used by finish()). */
  flushOnFinish() {
    if (this.pendingPattern) {
      this.host.patterns().push(this.pendingPattern);
      this.pendingPattern = null;
    }
    this.centreDrag = false;
    this.syncDot();
  }

  /** don't lose an in-progress pattern when the tool changes: keep it, then
   *  fully clear the placement/edit UI state (used by setTool()). */
  flushPending() {
    if (this.pendingPattern) this.host.patterns().push(this.pendingPattern);
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.sweep = null;
    this.centreDrag = false;
    this.syncDot();
  }

  /** Delete/Backspace while a pattern is pending: remove it outright. */
  deletePending() {
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.sweep = null;
    this.centreDrag = false;
    this.syncDot();
    this.host.requestSolve();
    this.host.dim().hide();
    setPrompt(null);
    this.host.refreshActive();
    this.host.onState();
  }

  /** Escape while a pattern is pending: restore the pre-edit pattern (editing) or
   *  keep the fresh placement at its current values (new). */
  cancelPending() {
    if (!this.pendingPattern) return;
    if (this.editOriginal) this.host.patterns().push(this.editOriginal); // restore the pre-edit pattern
    else this.host.patterns().push(this.pendingPattern); // a fresh placement: keep it at its current values
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.sweep = null;
    this.centreDrag = false;
    this.syncDot();
    this.host.requestSolve();
    this.host.dim().hide();
    setPrompt(null);
    this.host.refreshActive();
    this.host.onState();
  }

  /** Circular pattern with a selection: start pending at once, centred on the
   *  selection, so the centre dot is there to drag before any click. Returns
   *  false when there is nothing to centre on. */
  begin(): boolean {
    if (this.pendingPattern || this.host.tool() !== "patternCircular") return false;
    const c = selectionCentre([...this.host.selected()].map((id) => this.host.sourcePoint(id)));
    if (!c) return false;
    this.patternCenter = new THREE.Vector2(c.x, c.y);
    this.sweep = null;
    this.centreDrag = false;
    this.pendingPattern = this.defaultPattern("patternCircular", this.patternCenter);
    this.host.dim().show(this.patternDimDefs("patternCircular"), () => this.commit());
    this.placeHudAtCentre();
    setPrompt("Drag the centre dot to move it · move to sweep · click to commit · Esc");
    this.syncDot();
    this.host.refreshActive();
    return true;
  }

  /** Pointer down: a press on a circular pattern's centre dot starts dragging
   *  the centre instead of committing. */
  grabCentre(clientX: number, clientY: number): boolean {
    const pat = this.pendingPattern;
    if (!pat || pat.type !== "patternCircular") return false;
    if (!nearCentreDot(this.host.toScreen(pat.cx as number, pat.cy as number), { x: clientX, y: clientY })) return false;
    this.centreDrag = true;
    return true;
  }

  /** Pointer up: ends a centre drag, true when one was in flight. */
  releaseCentre(): boolean {
    if (!this.centreDrag) return false;
    this.centreDrag = false;
    return true;
  }

  private syncDot() {
    const pat = this.pendingPattern;
    this.host.showCentreDot(
      pat && pat.type === "patternCircular" ? { x: pat.cx as number, y: pat.cy as number } : null,
    );
  }

  private placeHudAtCentre() {
    const pat = this.pendingPattern;
    if (!pat || pat.type !== "patternCircular") return;
    const s = this.host.toScreen(pat.cx as number, pat.cy as number);
    // dim.position adds 16 px both ways, this lands the HUD just under the dot
    if (s) this.host.dim().position(s.x - 16, s.y);
  }

  click(p: THREE.Vector2) {
    if (!this.patternCenter) {
      if (ENTITY_PATTERNS.has(this.host.tool()) && this.host.selected().size === 0) {
        setPrompt("Select entities first, then choose a pattern tool");
        return;
      }
      this.patternCenter = p.clone();
      this.sweep = null;
      this.pendingPattern = this.defaultPattern(this.host.tool(), p);
      this.host.dim().show(this.patternDimDefs(this.pendingPattern.type), () => this.commit());
      this.syncDot();
      this.placeHudAtCentre();
      this.host.refreshActive();
      return;
    }
    this.commit(); // second click commits
  }

  private defaultPattern(tool: SketchTool, c: THREE.Vector2): SketchPattern {
    const id = newPatternId();
    const sources = [...this.host.selected()];
    if (tool === "boltCircle") return { id, type: "boltCircle", cx: c.x, cy: c.y, bcd: 40, count: 6, diameter: 6 };
    if (tool === "gridHoles") return { id, type: "gridHoles", cx: c.x, cy: c.y, diameter: 6, countX: 3, countY: 3, spacingX: 12, spacingY: 12 };
    if (tool === "hexHoles") return { id, type: "hexHoles", cx: c.x, cy: c.y, diameter: 6, spacing: 12, rings: 2 };
    if (tool === "honeycomb") return { id, type: "honeycomb", cx: c.x, cy: c.y, diameter: 12, spacing: 13, rings: 2 };
    if (tool === "patternCircular") return { id, type: "patternCircular", sources, cx: c.x, cy: c.y, count: 6, angle: 360 };
    return { id, type: "patternRect", sources, countX: 3, countY: 1, spacingX: 15, spacingY: 15 }; // patternRect
  }

  private patternDimDefs(type: SketchPattern["type"]) {
    if (type === "boltCircle") return [{ name: "count", label: "N" }, { name: "diameter", label: "Diameter", icon: "diameter" }];
    if (type === "gridHoles") return [{ name: "countX", label: "Nx" }, { name: "countY", label: "Ny" }, { name: "diameter", label: "Diameter", icon: "diameter" }];
    if (type === "hexHoles" || type === "honeycomb") return [{ name: "rings", label: "Rings" }, { name: "diameter", label: "Diameter", icon: "diameter" }];
    if (type === "patternCircular") return [{ name: "count", label: "N" }, { name: "angle", label: "Angle", icon: "angle", kind: "angle" as const }];
    return [{ name: "countX", label: "Nx" }, { name: "countY", label: "Ny" }]; // patternRect
  }

  /** Live sizing: cursor offset/distance from the start point drives the spatial
   *  param (bolt dia / spacing / grid-step / circular sweep); typed fields drive
   *  counts, and a typed value always outranks the cursor. */
  move(p: THREE.Vector2, e: PointerEvent) {
    if (!this.patternCenter || !this.pendingPattern) return;
    const pat = this.pendingPattern;
    const dim = this.host.dim();
    if (this.centreDrag && pat.type === "patternCircular") {
      pat.cx = p.x;
      pat.cy = p.y;
      this.patternCenter.copy(p);
      this.sweep = null; // the sweep is measured about the centre, so it starts over
      this.syncDot();
      this.placeHudAtCentre();
      this.host.refreshActive();
      return;
    }
    const dx = p.x - this.patternCenter.x, dy = p.y - this.patternCenter.y;
    const r = Math.hypot(dx, dy);
    const dimN = (name: string, fallback: number) => Math.round(dim.getValue(name) ?? fallback);
    if (pat.type === "boltCircle") {
      if (r > 1) pat.bcd = Math.round(2 * r * 10) / 10;
      pat.count = Math.max(1, dimN("count", pat.count as number));
      pat.diameter = dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "gridHoles") {
      if (r > 1) pat.spacingX = pat.spacingY = Math.round((r / 1.5) * 10) / 10;
      pat.countX = Math.max(1, dimN("countX", pat.countX as number));
      pat.countY = Math.max(1, dimN("countY", pat.countY as number));
      pat.diameter = dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "hexHoles" || pat.type === "honeycomb") {
      if (r > 1) pat.spacing = Math.round((r / 2) * 10) / 10;
      pat.rings = Math.max(0, dimN("rings", pat.rings as number));
      pat.diameter = dim.getValue("diameter") ?? (pat.diameter as number);
    } else if (pat.type === "patternRect") {
      pat.countX = Math.max(1, dimN("countX", pat.countX as number));
      pat.countY = Math.max(1, dimN("countY", pat.countY as number));
      if (pat.countY === 1) {
        // a single row is a LINE, so the drag says which way it runs as well as
        // how far apart, and the whole row follows the cursor instead of only
        // its X component. A grid keeps the axis-aligned steps it always had,
        // because there the two directions are separate answers.
        if (r > 1) {
          pat.spacingX = Math.round(r * 10) / 10;
          pat.angle = snapAngleDeg((Math.atan2(dy, dx) * 180) / Math.PI, e.altKey);
        }
      } else {
        // cursor offset from the start point = the spacing vector (the second instance)
        if (Math.abs(dx) > 1) pat.spacingX = Math.round(dx * 10) / 10;
        if (Math.abs(dy) > 1) pat.spacingY = Math.round(dy * 10) / 10;
      }
    } else if (pat.type === "patternCircular") {
      pat.count = Math.max(1, dimN("count", pat.count as number));
      const src = dim.isUserDriven("angle") ? null : this.firstSourcePoint(pat.sources);
      const swept = src
        ? patternSweepDeg({
            cx: this.patternCenter.x, cy: this.patternCenter.y,
            sx: src.x, sy: src.y, px: p.x, py: p.y,
            prev: this.sweep, free: e.altKey,
          })
        : null;
      if (swept != null) {
        this.sweep = swept;
        pat.angle = swept;
        dim.updateFromCursor({ angle: swept }); // skips the field once it is typed in
      } else {
        pat.angle = dim.getValue("angle") ?? (pat.angle as number);
      }
    }
    if (pat.type === "patternCircular") this.placeHudAtCentre();
    else dim.position(e.clientX, e.clientY);
    this.host.refreshActive();
  }

  /** the first source that still resolves, what the sweep is measured from */
  private firstSourcePoint(sources: readonly string[]): { x: number; y: number } | null {
    for (const id of sources) {
      const p = this.host.sourcePoint(id);
      if (p) return p;
    }
    return null;
  }

  commit() {
    if (!this.pendingPattern) return;
    this.host.patterns().push(this.pendingPattern);
    this.host.requestSolve();
    this.pendingPattern = null;
    this.editOriginal = null;
    this.patternCenter = null;
    this.sweep = null;
    this.centreDrag = false;
    this.syncDot();
    this.host.dim().hide();
    setPrompt(null);
    const selected = this.host.selected();
    if (selected.size) selected.clear(); // the pattern now owns the copies
    this.host.setTool("select"); // finish: one pattern per invocation (refreshes + notifies)
  }

  /** Associative editing: re-open an existing pattern's placement flow with its
   *  current values, so dragging/typing re-derives it live. Esc restores it. */
  edit(patId: string) {
    const patterns = this.host.patterns();
    const i = patterns.findIndex((p) => p.id === patId);
    if (i < 0) return;
    const pat = patterns[i];
    if (!pat) return;
    patterns.splice(i, 1); // pull it out; commit/cancel puts it back
    this.editOriginal = { ...pat };
    this.pendingPattern = pat;
    this.sweep = null; // the first drag sample re-seeds the accumulator from the cursor
    this.patternCenter = new THREE.Vector2(
      "cx" in pat ? (pat.cx as number) : 0,
      "cy" in pat ? (pat.cy as number) : 0,
    );
    this.centreDrag = false;
    this.host.setActiveTool(pat.type);
    const cur: Record<string, number> = {};
    const vals = pat as unknown as Record<string, number>;
    for (const d of this.patternDimDefs(pat.type)) {
      const v = vals[d.name];
      if (v !== undefined) cur[d.name] = v;
    }
    this.host.dim().show(this.patternDimDefs(pat.type), () => this.commit());
    this.host.dim().updateFromCursor(cur);
    setPrompt("Drag or type to change · click to commit · Delete removes · Esc");
    this.syncDot();
    this.placeHudAtCentre();
    this.host.refreshActive();
    this.host.onState();
  }
}
