import { describe, it, expect } from "vitest";
import { HOLD_MS, IDLE, holdStep } from "../../src/ui/holdGesture";
import type { HoldEffect, HoldEvent, HoldPhase } from "../../src/ui/holdGesture";

/** Replay a whole gesture and keep the effects, which is how these rules are
 *  actually felt, "press, wait, release over Center Rect" rather than one
 *  transition at a time. */
function run(events: HoldEvent[], from: HoldPhase = IDLE) {
  let state = from;
  const effects: HoldEffect[] = [];
  for (const ev of events) {
    const step = holdStep(state, ev);
    state = step.next;
    effects.push(step.effect);
  }
  return { state, effects };
}

const press = (groupId = "rectangle", hasVariants = true): HoldEvent => ({
  type: "press",
  groupId,
  hasVariants,
});
const hold: HoldEvent = { type: "hold" };
const releaseOutside: HoldEvent = { type: "release", over: null };
const releaseOver = (groupId: string, action: string): HoldEvent => ({
  type: "release",
  over: { groupId, action },
});

describe("a quick click", () => {
  it("runs the tool on the button face and changes nothing else", () => {
    // The common case by an enormous margin. If a click ever produced `pick`,
    // using a button would keep re-writing the setting it just read.
    const { state, effects } = run([press(), releaseOutside]);
    expect(effects).toEqual([{ kind: "none" }, { kind: "runDefault", groupId: "rectangle" }]);
    expect(state).toEqual(IDLE);
  });

  it("runs the default even on a button with no variants", () => {
    // A one-tool group has no flyout at all; it must still behave like a plain
    // button rather than needing the machine to be special-cased around it.
    const { effects } = run([press("line", false), releaseOutside]);
    expect(effects[1]).toEqual({ kind: "runDefault", groupId: "line" });
  });

  it("still runs when the pointer comes up over an unrelated flyout row", () => {
    // Release carries whatever was under the pointer; while merely `pressing`
    // that is meaningless, and reading it would let a stale row from a
    // previously open flyout hijack a plain click.
    const { effects } = run([press(), releaseOver("circle", "circle3")]);
    expect(effects[1]).toEqual({ kind: "runDefault", groupId: "rectangle" });
  });
});

describe("holding", () => {
  it("opens the flyout WITHOUT running the default", () => {
    // The bug this whole state machine exists to prevent: if the hold also
    // armed the tool, opening the Rectangle variants would start drawing a
    // rectangle behind the menu you are still reading.
    const { state, effects } = run([press(), hold]);
    expect(effects[1]).toEqual({ kind: "open", groupId: "rectangle" });
    expect(state).toEqual({ phase: "open", groupId: "rectangle" });
  });

  it("does not run the default on the release that ends the hold either", () => {
    // ...and it must not run it a moment later, when the finger comes up.
    const { effects } = run([press(), hold, releaseOutside]);
    expect(effects).toEqual([
      { kind: "none" },
      { kind: "open", groupId: "rectangle" },
      { kind: "close" },
    ]);
  });

  it("ignores the hold on a button with no variants, leaving the click intact", () => {
    // Nothing to show, but the press is still a press, so letting go after a
    // long hold on Line must still draw a line rather than silently doing
    // nothing because the machine had wandered into another phase.
    const { state, effects } = run([press("line", false), hold]);
    expect(effects[1]).toEqual({ kind: "none" });
    expect(state).toEqual({ phase: "pressing", groupId: "line", hasVariants: false });
    expect(holdStep(state, releaseOutside).effect).toEqual({ kind: "runDefault", groupId: "line" });
  });

  it("ignores a timer that outlived its press", () => {
    // The classic popup bug: you clicked, the tool ran, and 200ms later a menu
    // appears over the model because nobody cancelled the timeout.
    expect(holdStep(IDLE, hold)).toEqual({ next: IDLE, effect: { kind: "none" } });
    const open: HoldPhase = { phase: "open", groupId: "circle" };
    expect(holdStep(open, hold)).toEqual({ next: open, effect: { kind: "none" } });
  });
});

describe("picking a variant", () => {
  it("runs it and adopts it as the button's new default", () => {
    // The button is supposed to learn: one `pick` both runs the tool and moves
    // the face, so the next plain click does the thing you just chose.
    const { state, effects } = run([press(), hold, releaseOver("rectangle", "centerRectangle")]);
    expect(effects[2]).toEqual({ kind: "pick", groupId: "rectangle", action: "centerRectangle" });
    expect(state).toEqual(IDLE);
  });

  it("cancels when the pointer comes up outside the flyout", () => {
    // Backing out has to be possible after you have seen the variants,
    // otherwise a hold commits you to one of them.
    const { effects } = run([press(), hold, releaseOutside]);
    expect(effects[2]).toEqual({ kind: "close" });
  });

  it("cancels when the row belongs to a different group's flyout", () => {
    // Guards a fast switch between two buttons leaving the previous flyout's
    // markup on screen for a frame: a release over one of ITS rows must not
    // write that action into the group that is currently open.
    const { effects } = run([press(), hold, releaseOver("circle", "circle3")]);
    expect(effects[2]).toEqual({ kind: "close" });
  });

  it("works for a flyout opened by right-click, where there was no press", () => {
    // The right-click path arrives at `open` without ever passing through
    // `pressing`, so picking must not depend on a press having happened.
    const { effects } = run([
      { type: "contextmenu", groupId: "pattern", hasVariants: true },
      releaseOver("pattern", "patternCircular"),
    ]);
    expect(effects[1]).toEqual({ kind: "pick", groupId: "pattern", action: "patternCircular" });
  });
});

describe("right-click", () => {
  it("opens the flyout immediately, from idle", () => {
    const { state, effects } = run([{ type: "contextmenu", groupId: "circle", hasVariants: true }]);
    expect(effects[0]).toEqual({ kind: "open", groupId: "circle" });
    expect(state).toEqual({ phase: "open", groupId: "circle" });
  });

  it("never runs a tool, even mid-press", () => {
    // Right-clicking with the left button already down is a real thing people
    // do; it must open the menu, and the left release that follows must then
    // find itself in `open` and abandon rather than draw.
    const { state, effects } = run([
      press(),
      { type: "contextmenu", groupId: "rectangle", hasVariants: true },
      releaseOutside,
    ]);
    expect(effects.some((e) => e.kind === "runDefault")).toBe(false);
    expect(state).toEqual(IDLE);
  });

  it("just dismisses on a button that has no variants", () => {
    // A menu of one is worse than no menu; but a right-click there should still
    // clear a flyout left open by a neighbour.
    const openState: HoldPhase = { phase: "open", groupId: "circle" };
    expect(holdStep(openState, { type: "contextmenu", groupId: "line", hasVariants: false })).toEqual({
      next: IDLE,
      effect: { kind: "close" },
    });
    expect(holdStep(IDLE, { type: "contextmenu", groupId: "line", hasVariants: false })).toEqual({
      next: IDLE,
      effect: { kind: "none" },
    });
  });
});

describe("pressing while a flyout is open", () => {
  it("on the same button only dismisses, it does not also run the tool", () => {
    // Otherwise "I've seen enough, close this" would draw a rectangle.
    const { state, effects } = run([press(), hold, press(), releaseOutside]);
    expect(effects[2]).toEqual({ kind: "close" });
    expect(effects[3]).toEqual({ kind: "none" });
    expect(state).toEqual(IDLE);
  });

  it("on another button dismisses AND starts that button's press", () => {
    // Moving from one open flyout straight to the next tool is one gesture, not
    // two; requiring a throwaway click to close is what makes a palette feel
    // sticky.
    const { state, effects } = run([press(), hold, press("circle", true)]);
    expect(effects[2]).toEqual({ kind: "close" });
    expect(state).toEqual({ phase: "pressing", groupId: "circle", hasVariants: true });
    expect(holdStep(state, releaseOutside).effect).toEqual({ kind: "runDefault", groupId: "circle" });
  });
});

describe("cancelling", () => {
  it("closes an open flyout and runs nothing", () => {
    // Escape, pointercancel, or the window going away mid-gesture.
    const { state, effects } = run([press(), hold, { type: "cancel" }]);
    expect(effects[2]).toEqual({ kind: "close" });
    expect(state).toEqual(IDLE);
  });

  it("drops a press that never opened anything", () => {
    const { state, effects } = run([press(), { type: "cancel" }]);
    expect(effects[1]).toEqual({ kind: "none" });
    expect(state).toEqual(IDLE);
  });

  it("leaves a stray release harmless", () => {
    // A pointerup with no matching down, dragged out of the window and
    // released, then back in. It must not run the last tool touched.
    expect(holdStep(IDLE, releaseOutside)).toEqual({ next: IDLE, effect: { kind: "none" } });
    expect(holdStep(IDLE, releaseOver("circle", "circle2"))).toEqual({
      next: IDLE,
      effect: { kind: "none" },
    });
  });
});

describe("the hold threshold", () => {
  it("sits above a real click and below a wait that feels broken", () => {
    // A click is ~80-150ms of contact; anything near that would open flyouts by
    // accident. Past ~500ms (the touch long-press convention) a deliberate hold
    // starts to read as the app having hung.
    expect(HOLD_MS).toBeGreaterThan(200);
    expect(HOLD_MS).toBeLessThanOrEqual(500);
  });
});
