// How much of the model ONE edge pick means, when it is about to become a fillet
// or a chamfer.
//
// A blend cannot terminate mid-tangency, so picking an edge normally drags its
// whole tangent chain in (see edgeFeatureTool.tangentChain). Right for the rim of
// a plate; wrong for a user zoomed hard into one corner, who means that corner and
// gets the whole perimeter. So a pick carries a SCOPE, from two things the user
// already told us:
//
//   SHIFT, "exactly what I clicked". Explicit, so it beats everything else, and
//   additive: shift-click builds the member set one edge at a time.
//   ZOOM, nobody flies in to fill the screen with one corner and means the whole
//   rim. A guess, so it is only ever the DEFAULT; members stay click-toggleable.
//
// Both zoom readings are RATIOS. An absolute distance would mean different things
// on a 6mm cube and a 400mm plate, and the same part in inches would decide
// differently from the same part in mm.
//
// DOM/three-free so vitest covers it with no canvas, the pointer plumbing on both
// sides cannot run headless, and this is the part that decides what the user gets.

/** What a pick means: the tangent chain through it, or exactly that edge. */
export type PickScope = "chain" | "single";

/** Why a pick came out the way it did. Carried so the prompt can say it, a
 *  gesture that quietly blends 1 edge where it used to blend 14 is
 *  indistinguishable from a broken tangent walk unless the app says which it did
 *  and why. */
export type ScopeReason = "shift" | "zoom" | "tangent";

export interface ScopeDecision {
  scope: PickScope;
  reason: ScopeReason;
}

/** The camera's relationship to the edge under the cursor, in the units the
 *  viewport already has to hand. Any reading may be null (or non-finite),
 *  before the first build there is no model to measure, and a projection can
 *  degenerate behind the camera, and a missing reading simply withholds its
 *  vote rather than forcing an answer. */
export interface ScopeView {
  /** The picked edge's on-screen extent in CSS pixels: the diagonal of its
   *  projected bounding box, so a closed circle reads as its own diameter
   *  instead of the zero-length chord between its coincident ends. Larger than
   *  the viewport when the edge runs off both sides of the screen, which is
   *  exactly the state this is looking for. */
  edgePx: number | null;
  /** The viewport's SHORTER side in CSS pixels, the dimension an edge has to
   *  span to be unmissable, whatever the window's aspect ratio. */
  viewportPx: number;
  /** World units per screen pixel at the edge (viewport.pixelWorldSize). */
  pixelWorldSize: number | null;
  /** The model's bounding-box diagonal, world units. */
  modelDiagonal: number | null;
}

/** How much of the viewport's short side the picked edge must span before the
 *  view counts as close ON THAT EDGE.
 *
 *  0.9 is high on purpose: at that point the edge is essentially running out of
 *  frame, which takes a deliberate zoom. Anything looser starts firing on a long
 *  thin part seen whole, where the edge fills the screen because the PART does,
 *  and its tangent chain is still exactly what the user means. */
export const CLOSE_EDGE_SCREEN_FRACTION = 0.9;

/** How small the visible slice of the world has to get, as a fraction of the
 *  model's bbox diagonal, before the view counts as being in on a DETAIL.
 *
 *  The second reading exists because the first misses the case that matters
 *  most: a 0.5mm edge on a 200mm bracket stays small on screen however far in
 *  you fly, so its own length never votes. What HAS changed is that the part no
 *  longer fits in the frame, a third of the diagonal is comfortably past "I am
 *  looking at the whole thing" and still well short of the working zoom where a
 *  rim pick means the rim. */
export const DETAIL_VIEW_FRACTION = 0.35;

/** Fraction of the viewport's short side the picked edge spans, or null when
 *  there is no usable reading. */
export function edgeScreenFraction(view: ScopeView): number | null {
  const { edgePx, viewportPx } = view;
  if (edgePx == null || !Number.isFinite(edgePx) || edgePx < 0) return null;
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return null;
  return edgePx / viewportPx;
}

/** Fraction of the model's diagonal that currently fits across the viewport's
 *  short side, or null when there is no usable reading. Above 1 the whole model
 *  fits with room to spare; well below 1 the camera is in on a detail. */
export function viewWorldFraction(view: ScopeView): number | null {
  const { pixelWorldSize, viewportPx, modelDiagonal } = view;
  if (pixelWorldSize == null || !Number.isFinite(pixelWorldSize) || pixelWorldSize <= 0) return null;
  if (!Number.isFinite(viewportPx) || viewportPx <= 0) return null;
  if (modelDiagonal == null || !Number.isFinite(modelDiagonal) || modelDiagonal <= 0) return null;
  return (pixelWorldSize * viewportPx) / modelDiagonal;
}

/** True when the camera is close enough that ONE edge is the likely intent.
 *
 *  EITHER reading is enough. They answer different questions, "is this edge
 *  huge" and "is the part still in frame", and they fire at different zooms: a
 *  detail on a large part trips only the second, a small part inspected up close
 *  trips both. Requiring both would leave the small-part case, which is most of
 *  what this app models, never firing at all. */
export function zoomedInOnEdge(view: ScopeView): boolean {
  const onScreen = edgeScreenFraction(view);
  if (onScreen != null && onScreen >= CLOSE_EDGE_SCREEN_FRACTION) return true;
  const inWorld = viewWorldFraction(view);
  return inWorld != null && inWorld <= DETAIL_VIEW_FRACTION;
}

/** What one pick means. `shift` is the user saying it outright; the view is the
 *  guess that stands in when they have not. */
export function pickScope(req: { shift: boolean; view: ScopeView }): ScopeDecision {
  if (req.shift) return { scope: "single", reason: "shift" };
  if (zoomedInOnEdge(req.view)) return { scope: "single", reason: "zoom" };
  return { scope: "chain", reason: "tangent" };
}

/** Fold a new pick's scope into the one the selection already carries: SINGLE
 *  WINS, and keeps winning until a plain click replaces the selection outright.
 *
 *  Once any pick in a selection has asked for exactly-that-edge, mixing it with
 *  a chain expansion would build a member set whose shape the user cannot see
 *  before committing, the two edges they chose, plus however many the walk
 *  decided to bring along. Of the two possible errors, blending too FEW edges is
 *  a click from being fixed (every member is click-toggleable inside the tool);
 *  blending too many is an undo and a re-pick. */
export function mergeScope(current: PickScope, next: PickScope): PickScope {
  return current === "single" || next === "single" ? "single" : "chain";
}
