// The panel opens on the standard size nearest the picked round face. It writes a core `thread` feature with the choice
// in `spec`, so the panel reopens on it and the face is found again on every build.

import { shallowRef } from "vue";
import { setPrompt, toast } from "fundacad";
import type { Engine, Feature, Selector } from "fundacad";
import {
  PRINT_CLEARANCE,
  formatOffBy,
  nearestThread,
  threadChoices,
  threadFeature,
  type FaceIs,
  type Hand,
  type NearestThread,
  type ThreadChoice,
  type ThreadSystem,
} from "./threadSpec";

export interface ThreadDraft {
  /** The feature being edited, null for a new one. */
  editing: string | null;
  face: Selector;
  axis?: [number, number, number] | undefined;
  /** Diameter of the picked face, mm, null when reopened and not measured. */
  faceDiameter: number | null;
  external: boolean;
  system: ThreadSystem;
  designation: string;
  faceIs: FaceIs;
  hand: Hand;
  starts: number;
  printFit: boolean;
  clearance: number;
  length?: number | undefined;
  offset?: number | undefined;
}

export const threadDraft = shallowRef<ThreadDraft | null>(null);

const SETTLE_MS = 350;
const SYSTEMS_NEAREST: ThreadSystem[] = ["iso", "unc", "unf"];

export function choicesFor(system: ThreadSystem): ThreadChoice[] {
  return threadChoices().filter((c) => c.system === system);
}

export function choiceOf(d: ThreadDraft): ThreadChoice | null {
  return choicesFor(d.system).find((c) => c.designation === d.designation) ?? null;
}

/** The nearest size within one system, for when the system is switched. */
export function nearestIn(d: ThreadDraft, system: ThreadSystem): NearestThread | null {
  return d.faceDiameter == null ? null : nearestThread(d.faceDiameter, d.external, [system]);
}

/** "M6, 0.02 mm over tap drill", against the size chosen now. */
export function offByText(d: ThreadDraft): string {
  const c = choiceOf(d);
  if (!c || d.faceDiameter == null) return "";
  const ref = d.faceIs === "tap" ? c.tap : c.d;
  return formatOffBy({ choice: c, faceIs: d.faceIs, offBy: Math.round((d.faceDiameter - ref) * 1000) / 1000 });
}

export function featureOf(d: ThreadDraft, id: string): Feature | null {
  const choice = choiceOf(d);
  if (!choice) return null;
  return threadFeature({
    id,
    face: d.face as unknown as Record<string, unknown>,
    axis: d.axis,
    choice,
    faceIs: d.external ? "nominal" : d.faceIs,
    external: d.external,
    starts: d.starts,
    hand: d.hand,
    clearance: d.printFit ? d.clearance : 0,
    length: d.length,
    offset: d.offset,
  }) as unknown as Feature;
}

/** A draft for a freshly picked face, on the size it is nearest to. */
export function draftForFace(
  face: Selector,
  diameter: number,
  external: boolean,
  axis?: [number, number, number],
): ThreadDraft | null {
  const n = nearestThread(diameter, external, SYSTEMS_NEAREST);
  if (!n) return null;
  return {
    editing: null,
    face,
    axis,
    faceDiameter: diameter,
    external,
    system: n.choice.system,
    designation: n.choice.designation,
    faceIs: n.faceIs,
    hand: "right",
    starts: 1,
    printFit: false,
    clearance: PRINT_CLEARANCE,
  };
}

/** A draft that reopens a committed thread, or null for one with no standard spec. */
export function draftForFeature(f: Record<string, unknown>, faceDiameter: number | null): ThreadDraft | null {
  const spec = f.spec as Record<string, unknown> | undefined;
  if (!spec || typeof spec.system !== "string" || typeof spec.designation !== "string") return null;
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const clearance = num(f.clearance) ?? 0;
  return {
    editing: String(f.id),
    face: f.face as Selector,
    axis: f.axis as [number, number, number] | undefined,
    faceDiameter,
    external: spec.external !== false,
    system: spec.system as ThreadSystem,
    designation: spec.designation,
    faceIs: spec.faceIs === "nominal" ? "nominal" : "tap",
    hand: f.hand === "left" ? "left" : "right",
    starts: num(f.starts) ?? 1,
    printFit: clearance > 0,
    clearance: clearance > 0 ? clearance : PRINT_CLEARANCE,
    length: num(f.length),
    offset: num(f.offset),
  };
}

export class StandardThreadTool {
  active = false;
  private done: ((id: string | null) => void) | null = null;
  private timer = 0;
  private picking = false;

  private onKey = (ev: KeyboardEvent) => {
    if (!this.picking || ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopPropagation();
    this.cancel();
  };

  private onPointerUp = () => {
    if (this.picking) setTimeout(() => this.tryPicked(true), 0);
  };

  constructor(private e: Engine) {}

  start(done: (id: string | null) => void) {
    if (this.active) return;
    this.active = true;
    this.done = done;
    if (this.tryPicked(false)) return;
    this.picking = true;
    this.e.viewport.setSelectionMode("faces");
    setPrompt("Standard Thread: click a round face, a shaft or a bore · Esc to cancel");
    document.addEventListener("keydown", this.onKey, true);
    this.e.viewport.domElement.addEventListener("pointerup", this.onPointerUp);
  }

  /** Reopen a committed thread in the panel. False for a thread with no standard spec. */
  edit(id: string, done: (id: string | null) => void): boolean {
    if (this.active) return false;
    const f = this.e.store.document.features.find((x) => x.id === id) as Record<string, unknown> | undefined;
    const d = f ? draftForFeature(f, null) : null;
    if (!d) return false;
    this.active = true;
    this.done = done;
    this.e.store.beginEditPreview(id, f as unknown as Feature, { inPlace: true });
    threadDraft.value = d;
    return true;
  }

  private tryPicked(complain: boolean): boolean {
    const sel = this.e.viewport.selectedFacesForPressPull();
    const round = sel?.round;
    if (!sel || !round || sel.faceIds.length !== 1 || !sel.selectors[0]) {
      if (complain && sel) setPrompt("Standard Thread: that face is not round, pick a shaft or a bore · Esc to cancel");
      return false;
    }
    const s = sel.selectors[0];
    const face = (sel.bodyId && !("body" in s && s.body) ? { ...s, body: sel.bodyId } : s) as Selector;
    const a = round.cylinder.axis;
    const d = draftForFace(face, 2 * round.radius, round.solidInside, [a[0], a[1], a[2]]);
    if (!d) {
      toast("No standard thread is near that diameter.");
      return false;
    }
    this.stopPicking();
    threadDraft.value = d;
    this.changed();
    return true;
  }

  private stopPicking() {
    if (!this.picking) return;
    this.picking = false;
    setPrompt(null);
    document.removeEventListener("keydown", this.onKey, true);
    this.e.viewport.domElement.removeEventListener("pointerup", this.onPointerUp);
  }

  /** The draft moved: build the real thread once it stops moving. */
  changed() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      const d = threadDraft.value;
      if (!d) return;
      const f = featureOf(d, d.editing ?? this.e.store.nextId());
      if (d.editing) this.e.store.setEditPreview(f, { hold: true });
      else this.e.store.setPreview(f, { hold: true });
    }, SETTLE_MS);
  }

  apply() {
    const d = threadDraft.value;
    if (!d) return;
    const f = featureOf(d, d.editing ?? this.e.store.nextId());
    if (!f) return;
    this.close();
    if (d.editing) {
      this.e.store.endEditPreview(false);
      this.e.store.replaceFeature(d.editing, f);
    } else {
      this.e.store.setPreview(null);
      this.e.store.addFeature(f);
    }
    this.finish(f.id);
  }

  cancel() {
    const d = threadDraft.value;
    this.close();
    if (d?.editing) this.e.store.endEditPreview();
    else if (d) this.e.store.setPreview(null);
    this.finish(null);
  }

  private close() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = 0;
    this.stopPicking();
    threadDraft.value = null;
  }

  private finish(id: string | null) {
    const done = this.done;
    this.active = false;
    this.done = null;
    if (id) this.e.viewport.clearSelection();
    done?.(id);
  }
}

export const threadTool = shallowRef<StandardThreadTool | null>(null);
