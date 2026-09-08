// Carrying a selection across a STREAM, which is the half that was missing.
//
// setModel was taught to capture and restore a selection across a rebuild, and
// that was believed to cover it. It did not: a chunked reply reaches the screen
// in several installments and each one publishes a fresh ModelView with a fresh
// Highlighter, so the selection was gone before the commit ever ran — and the
// commit's own capture, reading that empty Highlighter, correctly answered
// "nothing is selected" and restored nothing.
//
// Measured in a real window before any of this was written: a face picked for
// the texture tool, then one preview rebuild, and the selection was empty in
// six runs out of six. The tool read that as the user deselecting, cleared its
// members, threw away the preview, and refused Add with "No faces selected"
// over a face that was lit up on screen. Whether a reply streams at all depends
// on how big it is, which is why it looked intermittent.
//
// The two rules that came out of it are pure, and they are what this file is
// about. Everything else about the fix is drawing.

import { describe, it, expect, vi } from "vitest";
import {
  MAX_GEOMETRIC_REMATCH, remapStreamedSelection, shouldAnnounce,
} from "../../src/viewport/selectionMemo";

/** A captured face: which body it was on, and whether that body has landed in
 *  the installment being restored onto. */
type Memo = { tag: string; landed: boolean };
const memo = (tag: string, landed: boolean): Memo => ({ tag, landed });

describe("remapStreamedSelection", () => {
  it("keeps a survivor whether or not its body has landed", () => {
    // A body reused whole is on screen from the FIRST installment: its
    // BodyMesh, its EdgeRefs and its faceId numbering all came straight
    // through, so there is nothing to wait for and nothing to re-find.
    const rematch = vi.fn(() => null);
    const out = remapStreamedSelection(
      [memo("a", false), memo("b", true)],
      (m) => m.tag,
      rematch,
      (m) => m.landed,
    );
    expect(out).toEqual(["a", "b"]);
    expect(rematch).not.toHaveBeenCalled();
  });

  it("holds the geometric fallback back until the body is there", () => {
    // THE RULE: a body whose chunk has not landed yet is not a body whose face
    // is gone. faceIdNear answers with the nearest face on ANYTHING that has
    // arrived, so letting it run here moves the selection onto another body —
    // worse than waiting, because the commit re-runs this and gets it right.
    const rematch = vi.fn((m: Memo) => `${m.tag}'`);
    const out = remapStreamedSelection(
      [memo("a", false)],
      () => null,
      rematch,
      (m) => m.landed,
    );
    expect(out).toEqual([]);
    expect(rematch).not.toHaveBeenCalled();
  });

  it("runs the fallback the moment the body does land", () => {
    // The control on the test above: same memo, same everything, one field
    // different. Without this the first test passes for a function that never
    // rematches at all.
    const rematch = vi.fn((m: Memo) => `${m.tag}'`);
    const out = remapStreamedSelection(
      [memo("a", true)],
      () => null,
      rematch,
      (m) => m.landed,
    );
    expect(out).toEqual(["a'"]);
    expect(rematch).toHaveBeenCalledTimes(1);
  });

  it("resolves the bodies that have landed and waits for the ones that have not", () => {
    const out = remapStreamedSelection(
      [memo("a", true), memo("b", false), memo("c", true)],
      () => null,
      (m) => `${m.tag}'`,
      (m) => m.landed,
    );
    expect(out).toEqual(["a'", "c'"]);
  });

  it("counts a held-back entity against the cap the same way a missing one is", () => {
    // The cap exists because the fallback is O(model) each. A stream re-runs
    // this on EVERY installment, so an uncapped one would be O(chunks x model x
    // entities) — the cost the cap was put there to refuse in the first place.
    const many = Array.from({ length: MAX_GEOMETRIC_REMATCH + 1 }, (_, i) => memo(`f${i}`, true));
    const rematch = vi.fn((m: Memo) => m.tag);
    expect(remapStreamedSelection(many, () => null, rematch, (m) => m.landed)).toEqual([]);
    expect(rematch).not.toHaveBeenCalled();
  });

  it("is exactly remapSelection when every body has landed", () => {
    // The commit's behaviour has to be reachable from here, because the commit
    // is the moment every body has landed by definition. A stream that stayed
    // permanently more cautious than the commit would lose selections the
    // one-shot path keeps.
    const out = remapStreamedSelection(
      [memo("a", true), memo("b", true)],
      (m) => (m.tag === "a" ? m.tag : null),
      (m) => `${m.tag}'`,
      () => true,
    );
    expect(out).toEqual(["a", "b'"]);
  });

  it("collapses duplicates the same way, so a toggle is never handed one twice", () => {
    const out = remapStreamedSelection(
      [memo("a", true), memo("b", true)],
      () => null,
      () => "merged",
      () => true,
    );
    expect(out).toEqual(["merged"]);
  });
});

describe("shouldAnnounce", () => {
  it("announces a commit that lost the selection", () => {
    // "The selection is gone" is exactly the news a drag handle needs in order
    // to take itself down, so a COMMIT tests what was captured, not what came
    // back. Removing this leaves a fillet arrow floating over an edge that no
    // longer exists.
    expect(shouldAnnounce(2, 0, false)).toBe(true);
  });

  it("says nothing about an installment that restored nothing", () => {
    // Mid-stream, "nothing came back" is the ordinary state of a reply that has
    // not delivered the right body yet. Announcing it takes the handle down and
    // ends the gesture a few milliseconds before the body lands, which is the
    // whole bug in miniature.
    expect(shouldAnnounce(2, 0, true)).toBe(false);
  });

  it("announces an installment that did restore something", () => {
    expect(shouldAnnounce(2, 2, true)).toBe(true);
  });

  it("stays quiet either way when nothing was selected to begin with", () => {
    expect(shouldAnnounce(0, 0, false)).toBe(false);
    expect(shouldAnnounce(0, 0, true)).toBe(false);
  });
});
