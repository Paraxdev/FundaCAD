// Which boolean an extrude gets, now that nothing asks.
//
// Every failure here is a version of the same complaint: "I dragged it out and
// it ate the part", or "I dragged it in and it did nothing". The modal used to
// stand between the guess and the document; with it gone the guess IS the
// document, so the rules are held here rather than trusted.

import { describe, it, expect } from "vitest";
import { OP_WORD, plannedOperation, type ExtrudeOp, type ExtrudeSituation } from "../../src/features/extrudeOperation";

/** A fresh extrude on a part, pulled away from material. The situation every
 *  case below varies one fact of. */
const boss: ExtrudeSituation = {
  savedOperation: null,
  hasSolid: true,
  entersSolid: false,
  allGlyphs: false,
};

describe("a fresh extrude", () => {
  it("joins when it pulls away from the part", () => {
    expect(plannedOperation(boss)).toBe("join");
  });

  it("cuts when it pushes into the part", () => {
    expect(plannedOperation({ ...boss, entersSolid: true })).toBe("cut");
  });

  it("makes a new body when there is nothing to boolean with", () => {
    expect(plannedOperation({ ...boss, hasSolid: false })).toBe("new");
    // CONTROL: it is the missing solid deciding, not the direction. An empty
    // document with the direction flipped must still answer "new" — otherwise
    // the first extrude of a document would come out as a Cut with nothing to
    // cut, which is the one answer that cannot be right.
    expect(plannedOperation({ ...boss, hasSolid: false, entersSolid: true })).toBe("new");
  });

  it("never guesses intersect", () => {
    const answers = new Set<ExtrudeOp>();
    for (const hasSolid of [true, false])
      for (const entersSolid of [true, false])
        for (const allGlyphs of [true, false])
          answers.add(plannedOperation({ savedOperation: null, hasSolid, entersSolid, allGlyphs }));
    expect(answers.has("intersect")).toBe(false);
    // CONTROL: the sweep really did reach every other answer, so "no intersect"
    // is a fact about the rules and not about a loop that never ran.
    expect([...answers].sort()).toEqual(["cut", "join", "new"]);
  });
});

describe("text", () => {
  it("gets its own body where a shape would have joined", () => {
    // Joined text cannot print in its own colour, and the two-tone path is the
    // reason anyone extrudes text flush in the first place.
    expect(plannedOperation({ ...boss, allGlyphs: true })).toBe("new");
  });

  it("still engraves when it is pushed in", () => {
    // An engraved glyph is a pocket and prints perfectly well, so the bias must
    // not reach it. Without this the only way to engrave text would be to
    // extrude a separate body and boolean it by hand.
    expect(plannedOperation({ ...boss, allGlyphs: true, entersSolid: true })).toBe("cut");
  });
});

describe("editing one that already exists", () => {
  it("keeps what it was committed with, whatever the geometry now says", () => {
    // Re-dragging the depth of a Cut must not turn it into a Join. The guess is
    // read off the geometry the edit is in the middle of changing, so during an
    // edit it is not evidence about anything.
    for (const saved of ["new", "join", "cut", "intersect"] as const) {
      expect(plannedOperation({ ...boss, savedOperation: saved, entersSolid: true })).toBe(saved);
      expect(plannedOperation({ ...boss, savedOperation: saved, entersSolid: false })).toBe(saved);
    }
  });

  it("keeps it when the rolled-back model has no solid left", () => {
    // Editing the extrude that MADE the first solid rolls the model back to
    // nothing. That is not a document with no body in it, it is this feature's
    // own input, and rewriting the operation to "new" there would silently
    // detach every later feature that referenced the joined result.
    expect(plannedOperation({ ...boss, savedOperation: "join", hasSolid: false })).toBe("join");
    // CONTROL: the same situation without a saved operation IS a new body, so
    // the line above is the saved value winning rather than the fallback
    // happening to agree.
    expect(plannedOperation({ ...boss, savedOperation: null, hasSolid: false })).toBe("new");
  });
});

describe("the prompt's words", () => {
  it("names every operation the rules can produce", () => {
    // The prompt is the whole replacement for the dialog. An operation with no
    // word would show up as "undefined · drag or type a depth".
    for (const op of ["new", "join", "cut", "intersect"] as const) {
      expect(OP_WORD[op]).toBeTruthy();
    }
  });
});
