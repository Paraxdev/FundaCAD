// The text the 3D view is described by (aria-describedby). A screen reader reads it on every focus of the view, so it
// stays four short sentences.

import { shallowRef } from "vue";
import type { StandardView } from "../viewport/cameras";

export const VIEW_SUMMARY_ID = "view-summary";

/** Written by app/describeModel.ts, rendered by ViewportPane.vue. */
export const viewSummaryText = shallowRef("");

export interface ViewFacts {
  /** The standard view the camera is square to, null for any other. */
  view: StandardView | null;
  ortho: boolean;
  section: boolean;
}

export interface SelectionFacts {
  /** Names of the selected bodies. */
  bodies: readonly string[];
  faces: number;
  edges: number;
}

export interface SummaryFacts {
  bodies: number;
  hidden: number;
  features: number;
  failed: number;
  view: ViewFacts;
  selection: SelectionFacts;
}

const VIEW_NAMES: Record<StandardView, string> = {
  front: "Front",
  back: "Back",
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
  iso: "Isometric",
};

// Where the eye sits from the target in each standard view, as cameras.ts and navigator/rig.ts place it.
const EYES: [StandardView, [number, number, number]][] = [
  ["front", [0, -1, 0]],
  ["back", [0, 1, 0]],
  ["left", [-1, 0, 0]],
  ["right", [1, 0, 0]],
  ["top", [0, 0, 1]],
  ["bottom", [0, 0, -1]],
  ["iso", [1, -1, 0.8]],
];

/** Within about 2.5 degrees of a standard view counts as that view. */
export function standardViewOf(eye: readonly [number, number, number]): StandardView | null {
  const len = Math.hypot(...eye);
  if (len < 1e-9) return null;
  for (const [view, d] of EYES) {
    const dot = (eye[0] * d[0] + eye[1] * d[1] + eye[2] * d[2]) / (len * Math.hypot(...d));
    if (dot > 0.999) return view;
  }
  return null;
}

export function count(n: number, one: string, many: string): string {
  return n === 0 ? `no ${many}` : `${n} ${n === 1 ? one : many}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function viewWords(v: ViewFacts): string {
  return `${v.view ? VIEW_NAMES[v.view] : "Custom"} view, ${v.ortho ? "orthographic" : "perspective"}`;
}

export function selectionWords(s: SelectionFacts): string {
  const parts: string[] = [];
  if (s.bodies.length === 1) parts.push(s.bodies[0]!);
  else if (s.bodies.length) parts.push(count(s.bodies.length, "body", "bodies"));
  if (s.faces) parts.push(count(s.faces, "face", "faces"));
  if (s.edges) parts.push(count(s.edges, "edge", "edges"));
  return parts.length ? `Selected: ${parts.join(", ")}` : "Nothing selected";
}

/** "2 bodies (1 hidden), 5 features (1 failed)". */
export function countWords(f: Pick<SummaryFacts, "bodies" | "hidden" | "features" | "failed">): string {
  const bodies = count(f.bodies, "body", "bodies") + (f.hidden ? ` (${f.hidden} hidden)` : "");
  const features = count(f.features, "feature", "features") + (f.failed ? ` (${f.failed} failed)` : "");
  return capital(`${bodies}, ${features}`);
}

export function viewSummary(f: SummaryFacts): string {
  return [countWords(f), viewWords(f.view), f.view.section ? "Section on" : "Section off", selectionWords(f.selection)]
    .map((s) => `${s}.`)
    .join(" ");
}
