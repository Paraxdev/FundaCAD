// What the view draws on top of the model, sorted into kinds the Display
// popover switches one by one. A kind is a three.js layer, and the camera's
// layer mask decides what is drawn: an object on a masked out layer costs no
// draw call, and its owner keeps writing `.visible` the way it always has.
// Layer 0 is the model and its lights. A saved picture reads the same list
// (pictureMask) and the allowlist in pictureScene.ts is its safety net.

import * as THREE from "three";
import { markNotInPicture } from "./pictureScene";

export const OVERLAY_KINDS = [
  "edges", "highlight", "grid", "origin", "sketches", "sketchLabels", "handles", "stress", "section",
] as const;
export type OverlayKind = (typeof OVERLAY_KINDS)[number];
export type OverlayKinds = Record<OverlayKind, boolean>;

export const OVERLAY_LABELS: Record<OverlayKind, string> = {
  edges: "Edge outlines",
  highlight: "Selection and hover",
  grid: "Grid",
  origin: "Origin and planes",
  sketches: "Sketches",
  sketchLabels: "Sketch dimensions",
  handles: "Gizmos and handles",
  stress: "Stress glyphs",
  section: "Section plane",
};

export interface OverlayState {
  /** The master switch. Off draws no overlay and leaves `kinds` as they were,
   *  which is what Clean view turns back on. */
  on: boolean;
  kinds: OverlayKinds;
}

/** What the view needs whatever the switches say: a running tool's handle, the
 *  sketch being drawn, the construction planes a plane pick is asking for. */
export interface ActiveWork {
  tool: boolean;
  sketch: boolean;
  planes: boolean;
}

const NO_WORK: Readonly<ActiveWork> = Object.freeze({ tool: false, sketch: false, planes: false });

const KIND = "overlay";

export function overlayLayer(kind: OverlayKind): number {
  return OVERLAY_KINDS.indexOf(kind) + 1;
}

export function overlayBit(kind: OverlayKind): number {
  return 1 << overlayLayer(kind);
}

const MODEL_BIT = 1;

export function allOverlaysOn(): OverlayKinds {
  return Object.fromEntries(OVERLAY_KINDS.map((k) => [k, true])) as OverlayKinds;
}

export const DEFAULT_OVERLAYS: Readonly<OverlayState> = Object.freeze({ on: true, kinds: Object.freeze(allOverlaysOn()) });

/** Untrusted JSON to a whole state; a kind it does not name is shown. */
export function asOverlays(v: unknown): OverlayState {
  const o = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const k = o["kinds"] && typeof o["kinds"] === "object" ? (o["kinds"] as Record<string, unknown>) : {};
  const kinds = allOverlaysOn();
  for (const kind of OVERLAY_KINDS) if (typeof k[kind] === "boolean") kinds[kind] = k[kind] as boolean;
  return { on: typeof o["on"] === "boolean" ? o["on"] : true, kinds };
}

export function overlayShown(s: Readonly<OverlayState>, kind: OverlayKind): boolean {
  return s.on && s.kinds[kind];
}

export function overlayKindOf(o: THREE.Object3D): OverlayKind | undefined {
  return o.userData[KIND] as OverlayKind | undefined;
}

/** Put `o` and everything under it on `kind`'s layer, except a descendant with
 *  a kind of its own. Layers are not inherited, so a child added later has to
 *  be covered again (syncOverlayLayers). */
export function markOverlay<T extends THREE.Object3D>(o: T, kind: OverlayKind): T {
  o.userData[KIND] = kind;
  // The edges' place in a picture is pictureMask's call, an export may ask for them.
  if (kind !== "edges") markNotInPicture(o);
  applyKind(o, kind);
  return o;
}

function applyKind(root: THREE.Object3D, kind: OverlayKind) {
  const layer = overlayLayer(kind);
  const walk = (o: THREE.Object3D) => {
    o.layers.set(layer);
    for (const c of o.children) {
      const own = overlayKindOf(c);
      if (own) applyKind(c, own);
      else walk(c);
    }
  };
  walk(root);
}

/** Re-cover the tagged top level objects, for children their owners added
 *  since. Only the scene's direct children are walked into, so the model's
 *  bodies are not visited; what lives under the model is tagged where it is made. */
export function syncOverlayLayers(scene: THREE.Object3D): void {
  for (const c of scene.children) {
    const kind = overlayKindOf(c);
    if (kind) applyKind(c, kind);
  }
}

/** The layers the view draws. */
export function drawMask(s: Readonly<OverlayState>, active: Readonly<ActiveWork> = NO_WORK): number {
  let m = MODEL_BIT;
  if (s.on) for (const k of OVERLAY_KINDS) if (s.kinds[k]) m |= overlayBit(k);
  if (active.tool) m |= overlayBit("handles");
  if (active.sketch) m |= overlayBit("sketches");
  if (active.planes) m |= overlayBit("origin");
  return m;
}

/** The layers a click can land on: what is drawn, plus the edges and the
 *  highlight, so a hidden outline still selects its edge. A hidden gizmo cannot
 *  be grabbed. */
export function pickMask(draw: number): number {
  return draw | overlayBit("edges") | overlayBit("highlight");
}

/** The layers a saved picture draws: the model, and the edges only when the
 *  export asks for them. */
export function pictureMask(opts: { edges?: boolean } = {}): number {
  return MODEL_BIT | (opts.edges ? overlayBit("edges") : 0);
}

let currentPick = pickMask(drawMask(DEFAULT_OVERLAYS));

/** Kept by the viewport whenever it changes the draw mask, read by every
 *  Raycaster that may hit a tagged object. */
export function setPickLayers(mask: number): void {
  currentPick = mask;
}

export function pickLayers<T extends THREE.Raycaster>(r: T): T {
  r.layers.mask = currentPick;
  return r;
}
