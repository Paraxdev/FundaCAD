// Shift means exactly the clicked edge, and a hard zoom guesses the same as a default, else a blend takes the
// tangent chain. Zoom readings are ratios, so a part's size or units never change the answer. DOM free for vitest.

export type PickScope = "chain" | "single";

/** Carried so the prompt can say why: 1 edge blended where 14 were before looks like a broken tangent walk. */
export type ScopeReason = "shift" | "zoom" | "tangent";

export interface ScopeDecision {
  scope: PickScope;
  reason: ScopeReason;
}

/** Any reading may be null or non finite (no model yet, a projection behind the camera), and a missing
 *  reading withholds its vote rather than forcing an answer. */
export interface ScopeView {
  /** CSS px diagonal of the edge's projected box, so a closed circle reads as its diameter. Larger than
   *  the viewport when the edge runs off both sides of the screen. */
  edgePx: number | null;
  /** The SHORTER side in CSS pixels, whatever the window's aspect ratio. */
  viewportPx: number;
  /** World units per screen pixel at the edge (viewport.pixelWorldSize). */
  pixelWorldSize: number | null;
  /** The model's bounding-box diagonal, world units. */
  modelDiagonal: number | null;
}

/** 0.9 means the edge is running out of frame, a deliberate zoom. Looser fires on a long thin part seen
 *  whole, whose tangent chain is still what the user means. */
export const CLOSE_EDGE_SCREEN_FRACTION = 0.9;

/** A 0.5mm edge on a 200mm bracket stays small on screen however close you fly, so the part no longer
 *  fitting the frame is what votes. */
export const DETAIL_VIEW_FRACTION = 0.35;

export function edgeScreenFraction(view: ScopeView): number | null {
  const { edgePx, viewportPx } = view;
  if (edgePx == null || !Number.isFinite(edgePx) || edgePx < 0) return null;
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return null;
  return edgePx / viewportPx;
}

/** Above 1 the whole model fits with room to spare; well below 1 the camera is in on a detail. */
export function viewWorldFraction(view: ScopeView): number | null {
  const { pixelWorldSize, viewportPx, modelDiagonal } = view;
  if (pixelWorldSize == null || !Number.isFinite(pixelWorldSize) || pixelWorldSize <= 0) return null;
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return null;
  if (modelDiagonal == null || !Number.isFinite(modelDiagonal) || modelDiagonal <= 0) return null;
  return (pixelWorldSize * viewportPx) / modelDiagonal;
}

/** Either reading is enough: a detail on a large part trips only the second, and requiring both would
 *  never fire on a small part, which is most of what this app models. */
export function zoomedInOnEdge(view: ScopeView): boolean {
  const onScreen = edgeScreenFraction(view);
  if (onScreen != null && onScreen >= CLOSE_EDGE_SCREEN_FRACTION) return true;
  const inWorld = viewWorldFraction(view);
  return inWorld != null && inWorld <= DETAIL_VIEW_FRACTION;
}

export function pickScope(req: { shift: boolean; view: ScopeView }): ScopeDecision {
  if (req.shift) return { scope: "single", reason: "shift" };
  if (zoomedInOnEdge(req.view)) return { scope: "single", reason: "zoom" };
  return { scope: "chain", reason: "tangent" };
}

/** Single wins until a plain click replaces the selection: too few blended edges is a click to fix inside
 *  the tool, too many is an undo and a re-pick. */
export function mergeScope(current: PickScope, next: PickScope): PickScope {
  return current === "single" || next === "single" ? "single" : "chain";
}
