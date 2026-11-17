// The text the 3D view is described by (aria-describedby). A screen reader reads it on every focus of the view, so it
// stays four short sentences.

import { shallowRef } from "vue";
import type { StandardView } from "../viewport/cameras";
import { t } from "../i18n";

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

export function viewWords(v: ViewFacts): string {
  const projection = v.ortho ? "ortho" : "persp";
  return v.view ? t("camera.standard", { view: v.view, projection }) : t("describe.view.custom", { projection });
}

export function selectionWords(s: SelectionFacts): string {
  const parts: string[] = [];
  if (s.bodies.length === 1) parts.push(s.bodies[0]!);
  else if (s.bodies.length) parts.push(t("describe.selected.count", { kind: "body", n: s.bodies.length }));
  if (s.faces) parts.push(t("describe.selected.count", { kind: "face", n: s.faces }));
  if (s.edges) parts.push(t("describe.selected.count", { kind: "edge", n: s.edges }));
  if (!parts.length) return t("selection.said.none");
  return t("describe.selected", { items: parts.reduce((before, after) => t("describe.next", { before, after })) });
}

/** "2 bodies (1 hidden), 5 features (1 failed)". */
export function countWords(f: Pick<SummaryFacts, "bodies" | "hidden" | "features" | "failed">): string {
  return t("describe.counts", { bodies: f.bodies, hidden: f.hidden, features: f.features, failed: f.failed });
}

export function viewSummary(f: SummaryFacts): string {
  return t("describe.summary", {
    counts: countWords(f),
    view: viewWords(f.view),
    section: t("describe.section", { on: f.view.section ? "yes" : "no" }),
    selection: selectionWords(f.selection),
  });
}
