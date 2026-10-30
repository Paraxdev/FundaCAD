import type { StressSpot } from "../types";
import type { StressFaceSet, StressSetup } from "./stress";

/** Typing in one box or dragging one spot within this long of the last change stays one step. */
export const MERGE_MS = 1500;
const MAX_STEPS = 100;

export interface StressChange {
  label: string;
  /** Whether a quick follow up with the same label folds into this step. */
  merge: boolean;
}

interface Step {
  label: string;
  before: StressSetup;
  beforeKey: string;
  after: StressSetup;
  afterKey: string;
  merge: boolean;
  at: number;
}

function clone(s: StressSetup): StressSetup {
  return JSON.parse(JSON.stringify(s)) as StressSetup;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The setup as the user made it: a face set is only its selectors, so finding the faces again on a new build is not a
 *  change. */
export function setupKey(s: StressSetup): string {
  return JSON.stringify([
    s.body,
    s.supports.map((x) => [x.id, x.type, x.faces.selectors, x.spots ?? []]),
    s.loads.map((l) => [l.id, l.kind, l.faces.selectors, l.spots ?? [], l.force, l.direction, l.custom, l.pressure]),
    [s.gravity.on, s.gravity.direction],
    s.material,
    [s.custom.E, s.custom.nu, s.custom.yield, s.custom.density],
    s.size,
    s.refine,
  ]);
}

function rowsChange(
  name: "support" | "load",
  before: readonly { id: number }[],
  after: readonly { id: number }[],
): StressChange | null {
  if (after.length > before.length) return { label: `Add ${name}`, merge: false };
  if (after.length < before.length) {
    const gone = before.findIndex((r) => !after.some((a) => a.id === r.id));
    return { label: `Remove ${name} ${(gone < 0 ? before.length - 1 : gone) + 1}`, merge: false };
  }
  return null;
}

function placesChange(
  row: string,
  a: { faces: StressFaceSet; spots?: StressSpot[] },
  b: { faces: StressFaceSet; spots?: StressSpot[] },
): StressChange | null {
  const faces = !same(a.faces.selectors, b.faces.selectors);
  const sa = a.spots ?? [];
  const sb = b.spots ?? [];
  const spots = !same(sa, sb);
  if (faces && spots) return { label: `${row} faces and spots`, merge: false };
  if (faces) return { label: `${row} faces`, merge: false };
  if (!spots) return null;
  if (sa.length === sb.length) {
    const k = sa.findIndex((s, i) => s.radius !== sb[i].radius);
    if (k >= 0 && sa.every((s, i) => same(s.at, sb[i].at)))
      return { label: `${row} spot ${k + 1} radius`, merge: true };
  }
  return { label: `${row} spots`, merge: false };
}

/** The panel's name for what changed from `before` to `after`, rows numbered as the panel shows them. */
export function describeStressChange(before: StressSetup, after: StressSetup): StressChange {
  if (before.body !== after.body) return { label: "Body", merge: false };
  const rows = rowsChange("support", before.supports, after.supports);
  if (rows) return rows;
  for (let i = 0; i < before.supports.length; i++) {
    const a = before.supports[i];
    const b = after.supports[i];
    if (a.id !== b.id) return { label: "Supports", merge: false };
    if (a.type !== b.type) return { label: `Support ${i + 1} type`, merge: false };
    const places = placesChange(`Support ${i + 1}`, a, b);
    if (places) return places;
  }
  const loads = rowsChange("load", before.loads, after.loads);
  if (loads) return loads;
  for (let i = 0; i < before.loads.length; i++) {
    const a = before.loads[i];
    const b = after.loads[i];
    const row = `Load ${i + 1}`;
    if (a.id !== b.id) return { label: "Loads", merge: false };
    if (a.kind !== b.kind) return { label: `${row} kind`, merge: false };
    const places = placesChange(row, a, b);
    if (places) return places;
    if (a.force !== b.force) return { label: `${row} force`, merge: true };
    if (a.direction !== b.direction) return { label: `${row} direction`, merge: false };
    if (!same(a.custom, b.custom)) return { label: `${row} direction`, merge: true };
    if (a.pressure !== b.pressure) return { label: `${row} pressure`, merge: true };
  }
  if (!same(before.gravity, after.gravity)) return { label: "Own weight", merge: false };
  if (before.material !== after.material) return { label: "Material", merge: false };
  if (!same(before.custom, after.custom)) return { label: "Material", merge: true };
  if (before.size !== after.size) return { label: "Mesh size", merge: true };
  if (before.refine !== after.refine) return { label: "Refinement", merge: false };
  return { label: "Stress setup", merge: false };
}

/** Undo and redo of the Stress setup alone, apart from the model's history. The caller notes each settled setup and
 *  puts back what undo and redo return. */
export class StressHistory {
  private done: Step[] = [];
  private undone: Step[] = [];
  private last: StressSetup | null = null;
  private lastKey = "";
  // Off after an undo or redo, so the next change starts its own step.
  private folding = false;

  get canUndo(): boolean {
    return this.done.length > 0;
  }

  get canRedo(): boolean {
    return this.undone.length > 0;
  }

  reset(setup: StressSetup | null): void {
    this.done = [];
    this.undone = [];
    this.folding = false;
    this.settle(setup);
  }

  note(setup: StressSetup | null, now: number): void {
    if (!setup) return this.settle(null);
    const key = setupKey(setup);
    if (key === this.lastKey) return;
    const before = this.last;
    if (!before) return this.settle(setup, key);
    const change = describeStressChange(before, setup);
    const top = this.done[this.done.length - 1];
    if (this.folding && change.merge && top?.merge && top.label === change.label && now - top.at <= MERGE_MS) {
      if (key === top.beforeKey) this.done.pop();
      else Object.assign(top, { after: clone(setup), afterKey: key, at: now });
    } else {
      this.done.push({
        label: change.label,
        before,
        beforeKey: this.lastKey,
        after: clone(setup),
        afterKey: key,
        merge: change.merge,
        at: now,
      });
      if (this.done.length > MAX_STEPS) this.done.shift();
    }
    this.undone = [];
    this.folding = true;
    this.settle(setup, key);
  }

  /** The setup before the last step, or null with nothing left. `current` is the setup as it stands now. */
  undo(current: StressSetup | null, now: number): { setup: StressSetup; label: string } | null {
    this.note(current, now);
    const step = this.done.pop();
    if (!step) return null;
    this.undone.push(step);
    this.folding = false;
    this.settle(step.before, step.beforeKey);
    return { setup: clone(step.before), label: step.label };
  }

  redo(current: StressSetup | null, now: number): { setup: StressSetup; label: string } | null {
    this.note(current, now);
    const step = this.undone.pop();
    if (!step) return null;
    this.done.push(step);
    this.folding = false;
    this.settle(step.after, step.afterKey);
    return { setup: clone(step.after), label: step.label };
  }

  private settle(setup: StressSetup | null, key = setup ? setupKey(setup) : ""): void {
    this.last = setup ? clone(setup) : null;
    this.lastKey = key;
  }
}
