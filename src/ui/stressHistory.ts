import { t, type MessageArgs, type MessageKey } from "../i18n";
import type { StressSpot } from "../types";
import type { StressFaceSet, StressSetup } from "./stress";

/** Typing in one box or dragging one spot within this long of the last change stays one step. */
export const MERGE_MS = 1500;
const MAX_STEPS = 100;

export interface StressChange {
  /** Read in the language of the moment, so a step noted before a switch reads in the new language. */
  readonly label: string;
  /** Whether a quick follow up with the same label folds into this step. */
  readonly merge: boolean;
}

// The key and args behind a change's label, off the object so a change still compares equal to { label, merge }.
const ids = new WeakMap<StressChange, { key: MessageKey; sig: string }>();

function change(key: MessageKey, merge: boolean, args?: MessageArgs): StressChange {
  const c: StressChange = {
    get label() {
      return t(key, args);
    },
    merge,
  };
  ids.set(c, { key, sig: JSON.stringify([key, args ?? null]) });
  return c;
}

const sigOf = (c: StressChange): string => ids.get(c)!.sig;

interface Step {
  change: StressChange;
  before: StressSetup;
  beforeKey: string;
  after: StressSetup;
  afterKey: string;
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
    s.refine,
  ]);
}

function rowsChange(
  name: "support" | "load",
  before: readonly { id: number }[],
  after: readonly { id: number }[],
): StressChange | null {
  if (after.length > before.length)
    return change(name === "support" ? "stress.setup.addSupport" : "stress.setup.addLoad", false);
  if (after.length < before.length) {
    const gone = before.findIndex((r) => !after.some((a) => a.id === r.id));
    return change(name === "support" ? "stress.setup.removeSupport" : "stress.setup.removeLoad", false, {
      i: (gone < 0 ? before.length - 1 : gone) + 1,
    });
  }
  return null;
}

function placesChange(
  row: "support" | "load",
  i: number,
  a: { faces: StressFaceSet; spots?: StressSpot[] },
  b: { faces: StressFaceSet; spots?: StressSpot[] },
): StressChange | null {
  const faces = !same(a.faces.selectors, b.faces.selectors);
  const sa = a.spots ?? [];
  const sb = b.spots ?? [];
  const spots = !same(sa, sb);
  const args = { row, i };
  if (faces && spots) return change("stress.undo.facesAndSpots", false, args);
  if (faces) return change("stress.undo.faces", false, args);
  if (!spots) return null;
  if (sa.length === sb.length) {
    const k = sa.findIndex((s, i) => s.radius !== sb[i]!.radius);
    if (k >= 0 && sa.every((s, i) => same(s.at, sb[i]!.at)))
      return change("stress.undo.spotRadius", true, { ...args, k: k + 1 });
  }
  return change("stress.undo.spots", false, args);
}

/** The panel's name for what changed from `before` to `after`, rows numbered as the panel shows them. */
export function describeStressChange(before: StressSetup, after: StressSetup): StressChange {
  if (before.body !== after.body) {
    // The first faces picked on a setup with no body pick the body too, the user did the picking.
    const bare = [...before.supports, ...before.loads].every((r) => !r.faces.selectors.length && !r.spots?.length);
    const rest = before.body === null && bare ? describeStressChange({ ...before, body: after.body }, after) : null;
    return rest && ids.get(rest)!.key !== "stress.undo.setup" ? rest : change("stress.setup.body", false);
  }
  const rows = rowsChange("support", before.supports, after.supports);
  if (rows) return rows;
  for (const [i, a] of before.supports.entries()) {
    const b = after.supports[i]!;
    if (a.id !== b.id) return change("stress.setup.supports", false);
    if (a.type !== b.type) return change("stress.setup.supportType", false, { i: i + 1 });
    const places = placesChange("support", i + 1, a, b);
    if (places) return places;
  }
  const loads = rowsChange("load", before.loads, after.loads);
  if (loads) return loads;
  for (const [i, a] of before.loads.entries()) {
    const b = after.loads[i]!;
    const args = { i: i + 1 };
    if (a.id !== b.id) return change("stress.setup.loads", false);
    if (a.kind !== b.kind) return change("stress.setup.loadKind", false, args);
    const places = placesChange("load", i + 1, a, b);
    if (places) return places;
    if (a.force !== b.force) return change("stress.undo.force", true, args);
    if (a.direction !== b.direction) return change("stress.undo.direction", false, args);
    if (!same(a.custom, b.custom)) return change("stress.undo.direction", true, args);
    if (a.pressure !== b.pressure) return change("stress.undo.pressure", true, args);
  }
  if (!same(before.gravity, after.gravity)) return change("stress.setup.ownWeight", false);
  if (before.material !== after.material) return change("stress.setup.material", false);
  if (!same(before.custom, after.custom)) return change("stress.setup.material", true);
  if (before.refine !== after.refine) return change("stress.setup.meshDetail", false);
  return change("stress.undo.setup", false);
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

  get undoLabel(): string | null {
    return this.done.at(-1)?.change.label ?? null;
  }

  get redoLabel(): string | null {
    return this.undone.at(-1)?.change.label ?? null;
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
    const made = describeStressChange(before, setup);
    const top = this.done[this.done.length - 1];
    if (
      this.folding &&
      made.merge &&
      top?.change.merge &&
      sigOf(top.change) === sigOf(made) &&
      now - top.at <= MERGE_MS
    ) {
      if (key === top.beforeKey) this.done.pop();
      else Object.assign(top, { after: clone(setup), afterKey: key, at: now });
    } else {
      this.done.push({
        change: made,
        before,
        beforeKey: this.lastKey,
        after: clone(setup),
        afterKey: key,
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
    return { setup: clone(step.before), label: step.change.label };
  }

  redo(current: StressSetup | null, now: number): { setup: StressSetup; label: string } | null {
    this.note(current, now);
    const step = this.undone.pop();
    if (!step) return null;
    this.done.push(step);
    this.folding = false;
    this.settle(step.after, step.afterKey);
    return { setup: clone(step.after), label: step.change.label };
  }

  private settle(setup: StressSetup | null, key = setup ? setupKey(setup) : ""): void {
    this.last = setup ? clone(setup) : null;
    this.lastKey = key;
  }
}
