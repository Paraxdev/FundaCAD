// Which boolean an extrude performs, decided rather than asked.
//
// This used to be a four-way modal on every commit: the tool had already worked
// the answer out, and stopped to have it confirmed. The dialog cost a decision
// per extrude in order to catch the few where the guess was wrong, and the guess
// is right in the ordinary case — a profile drawn on a face and pulled off it is
// a boss, the same profile pushed into the part is a pocket.
//
// Pure, and separate from the tool, because it is the part that is easy to get
// quietly wrong. Every input is a fact somebody else measured: whether the model
// has a solid in it, whether the extrude direction enters material, whether the
// profile is all text. Nothing here raycasts, reads a store, or knows what a
// viewport is.
//
// The answer is a DEFAULT, not a verdict. document/optionFields.ts carries the
// Operation row, so a wrong guess is one dropdown away in Properties and never a
// feature that has to be deleted and redone.

export type ExtrudeOp = "new" | "join" | "cut" | "intersect";

export interface ExtrudeSituation {
  /** The operation already committed, when this is an EDIT of an existing
   *  extrude. Null on a fresh one. */
  savedOperation: ExtrudeOp | null;
  /** Is there any solid in the model at this point in the timeline? */
  hasSolid: boolean;
  /** Does the extrude direction push the profile INTO material? */
  entersSolid: boolean;
  /** Is every selected area a text glyph? */
  allGlyphs: boolean;
}

/** The operation an extrude will be committed with.
 *
 *  Four rules, in the order they win:
 *
 *  1. An EDIT keeps what it was committed with. Re-guessing would let re-dragging
 *     the depth of a Cut turn it silently into a Join — and the guess is read off
 *     the very geometry the edit is in the middle of changing. It also covers the
 *     rolled-back model with no solid in it, which is what an edit of the FIRST
 *     solid looks like: still an edit, not a rewrite to "new".
 *  2. Nothing to boolean with means a new body.
 *  3. All-glyph profiles (sketch text) get a new body even where the direction
 *     says join, because joined text cannot print in its own colour. Cut
 *     (engraving) is untouched — an engraved glyph is a pocket and prints fine.
 *  4. Otherwise the direction decides: into material cuts, away from it joins.
 *
 *  "intersect" is never guessed. It is in the union because the document and the
 *  Properties row both offer it, and there is no situation that IMPLIES it. */
export function plannedOperation(s: ExtrudeSituation): ExtrudeOp {
  if (s.savedOperation) return s.savedOperation;
  if (!s.hasSolid) return "new";
  const guess: ExtrudeOp = s.entersSolid ? "cut" : "join";
  if (s.allGlyphs && guess === "join") return "new";
  return guess;
}

/** What the prompt calls each operation while the depth is being dragged.
 *
 *  It leads the line: the answer first, then how to change the depth. That line
 *  is what carries the dialog's one honest job — saying which boolean you are
 *  about to get — without stopping the gesture to say it. */
export const OP_WORD: Record<ExtrudeOp, string> = {
  new: "New body",
  join: "Join",
  cut: "Cut",
  intersect: "Intersect",
};
