// In-sketch undo/redo as a pure, headlessly testable state machine. SketchMode diffs against a rolling `preEdit`
// snapshot at requestSolve, the one choke point every user edit passes, instead of instrumenting ~59 mutation sites.

import type { SketchConstraint, SketchPattern } from "../types";
import type { ResolvedEntity } from "./snap";

/** The whole of what a sketch edit can change, which one undo step restores. */
export type SketchSnapshot = {
  entities: ResolvedEntity[];
  constraints: SketchConstraint[];
  patterns: SketchPattern[];
};

export function cloneSnapshot(s: SketchSnapshot): SketchSnapshot {
  return JSON.parse(JSON.stringify(s)) as SketchSnapshot;
}

const same = (a: SketchSnapshot, b: SketchSnapshot) => JSON.stringify(a) === JSON.stringify(b);

export class SketchHistory {
  private undoStack: SketchSnapshot[] = [];
  private redoStack: SketchSnapshot[] = [];
  /** The last SETTLED state: always the pre-mutation snapshot an undo restores. */
  private preEdit: SketchSnapshot | null = null;

  constructor(private readonly cap = 100) {}

  reset(now?: SketchSnapshot) {
    this.undoStack = [];
    this.redoStack = [];
    this.preEdit = now ? cloneSnapshot(now) : null;
  }

  /** Re-arm the baseline without banking. Used when the state settles after a
   *  solve, and by DERIVED updates to make themselves invisible to bankIfChanged. */
  arm(now: SketchSnapshot) {
    this.preEdit = cloneSnapshot(now);
  }

  bankIfChanged(now: SketchSnapshot): boolean {
    if (!this.preEdit || same(now, this.preEdit)) return false;
    this.push(this.preEdit);
    this.preEdit = cloneSnapshot(now);
    return true;
  }

  /** For a continuous gesture (a drag) that collapses to ONE step; its frames never reached bankIfChanged. */
  bankBefore(before: SketchSnapshot, now: SketchSnapshot): boolean {
    if (same(before, now)) return false;
    this.push(cloneSnapshot(before));
    this.preEdit = cloneSnapshot(now);
    return true;
  }

  private push(s: SketchSnapshot) {
    this.undoStack.push(s);
    if (this.undoStack.length > this.cap) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Re-arms the baseline to the restored state so the undo itself is never banked. */
  undo(now: SketchSnapshot): SketchSnapshot | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(cloneSnapshot(now));
    this.preEdit = cloneSnapshot(prev);
    return cloneSnapshot(prev); // never hand out a reference into the history
  }

  redo(now: SketchSnapshot): SketchSnapshot | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(cloneSnapshot(now));
    this.preEdit = cloneSnapshot(next);
    return cloneSnapshot(next);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }
  get depth(): number {
    return this.undoStack.length;
  }
}
