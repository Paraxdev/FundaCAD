// When the path tracer may spend GPU time. Pure, so the switching rules are
// tested without a GPU.

import type { ViewMode } from "../../ui/renderPrefs";

/** The camera has to rest this long before tracing resumes. */
export const STILL_MS = 150;

export interface TraceInputs {
  mode: ViewMode;
  visible: boolean;
  stillMs: number;
  /** A gizmo drag is under way; the tracer is refitted once on release. */
  dragging?: boolean;
  /** The pref; off keeps tracing while the view moves. */
  realtimeWhileMoving?: boolean;
  sectioned: boolean;
  xray: boolean;
  wireframe: boolean;
  sketchOpen: boolean;
  samples: number;
  cap: number;
}

export type TraceState =
  | "off" | "hidden" | "moving" | "done" | "trace"
  | "paused:section" | "paused:xray" | "paused:wireframe" | "paused:sketch";

export function traceState(i: TraceInputs): TraceState {
  if (i.mode !== "pathtraced") return "off";
  if (!i.visible) return "hidden";
  if (i.sectioned) return "paused:section";
  if (i.xray) return "paused:xray";
  if (i.wireframe) return "paused:wireframe";
  if (i.sketchOpen) return "paused:sketch";
  if (i.realtimeWhileMoving !== false && (i.stillMs < STILL_MS || i.dragging)) return "moving";
  if (i.samples >= i.cap) return "done";
  return "trace";
}

export function isPaused(s: TraceState): boolean {
  return s.startsWith("paused:");
}

/** Every camera move or scene change bumps it; work tagged with an older
 *  number is dropped when it lands. */
export class TraceGeneration {
  private n = 0;
  get current(): number {
    return this.n;
  }
  bump(): number {
    return ++this.n;
  }
  isCurrent(g: number): boolean {
    return g === this.n;
  }
}
