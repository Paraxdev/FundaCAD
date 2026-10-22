// Which boolean an extrude performs, decided rather than asked: a profile pulled off a face is a boss, pushed into
// the part a pocket. It is only a default, the Operation row (document/optionFields.ts) changes it.

export type ExtrudeOp = "new" | "join" | "cut" | "intersect";

export interface ExtrudeSituation {
  /** On an edit, the operation already committed; null on a fresh extrude. */
  savedOperation: ExtrudeOp | null;
  /** Is there any solid in the model at this point in the timeline? */
  hasSolid: boolean;
  entersSolid: boolean;
  /** Is every selected area a text glyph? */
  allGlyphs: boolean;
}

/** An edit keeps its committed operation: re-guessing would turn a re-dragged Cut into a Join, and an edit of the first
 *  solid rolls back to a model with none. With no solid it is new. All glyph profiles that would join become a new
 *  body so text prints in its own colour (engraving cuts are fine). Otherwise into material cuts, away from it joins.
 *  Intersect is never guessed. */
export function plannedOperation(s: ExtrudeSituation): ExtrudeOp {
  if (s.savedOperation) return s.savedOperation;
  if (!s.hasSolid) return "new";
  const guess: ExtrudeOp = s.entersSolid ? "cut" : "join";
  if (s.allGlyphs && guess === "join") return "new";
  return guess;
}

/** Leads the drag prompt, so it says which boolean you will get without stopping the gesture. */
export const OP_WORD: Record<ExtrudeOp, string> = {
  new: "New body",
  join: "Join",
  cut: "Cut",
  intersect: "Intersect",
};
