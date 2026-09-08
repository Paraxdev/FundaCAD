// The press-and-hold gesture on the ribbon's split buttons, as a state machine
// with no DOM in it.
//
// A split button carries two meanings on one pointer: press and let go runs the
// tool on the face; press and KEEP HOLDING opens the family, and the tool you
// release over both runs and becomes the new face. The caret beside it opens the
// same list on a plain click, for anyone who would rather not hold anything.
//
// The failure this shape prevents is the one that makes a toolbar feel broken: a
// hold that ALSO runs the default on release, so opening the Rectangle family
// draws a rectangle nobody asked for. That cannot happen here, because opening
// leaves the `pressing` phase and only `pressing` produces runDefault.
//
// Nothing reads a clock, the component owns the timer and sends `hold` when it
// fires. That keeps the rules synchronous and testable, and a timer that outlives
// its press is just an event arriving in a phase that ignores it.

/** How long the pointer must stay down before the flyout opens, in ms.
 *
 *  Long enough that an ordinary click, press, release, roughly 80-150ms, can
 *  never trip it, short enough that holding on purpose does not feel like the
 *  app has stopped responding. The touch convention is ~500ms, which is tuned
 *  for accidental contact with a screen; a deliberate press on a mouse needs
 *  much less patience, and a sketch toolbar is used hundreds of times an hour. */
export const HOLD_MS = 300;

export type HoldPhase =
  /** Nothing pressed, nothing open. */
  | { phase: "idle" }
  /** Pointer is down on a button; the hold timer is running and the flyout is
   *  still shut. `hasVariants` rides along so the machine can answer the hold
   *  without being handed the tool tables. */
  | { phase: "pressing"; groupId: string; hasVariants: boolean }
  /** The flyout for `groupId` is on screen, reached by holding, or straight
   *  away from a right-click. */
  | { phase: "open"; groupId: string };

export const IDLE: HoldPhase = { phase: "idle" };

export type HoldEvent =
  /** Primary-button pointerdown on a split button's face. */
  | { type: "press"; groupId: string; hasVariants: boolean }
  /** The hold timer fired. */
  | { type: "hold" }
  /** Primary-button pointerup anywhere. `over` is the family row under the
   *  pointer at that instant, or null for "released over nothing". */
  | { type: "release"; over: { groupId: string; action: string } | null }
  /** Right-click (contextmenu) on a split button, the shortcut for people who
   *  already know the flyout is there and do not want to wait for it. */
  | { type: "contextmenu"; groupId: string; hasVariants: boolean }
  /** Escape, pointercancel, a press outside, losing the window. */
  | { type: "cancel" };

export type HoldEffect =
  | { kind: "none" }
  /** Show the family list for this group. */
  | { kind: "open"; groupId: string }
  /** Hide whatever is showing. */
  | { kind: "close" }
  /** Run the tool currently on the button face, and leave that choice alone,
   *  a click is a use of the default, not a vote for it. */
  | { kind: "runDefault"; groupId: string }
  /** Run this variant AND make it the group's new default. */
  | { kind: "pick"; groupId: string; action: string };

const NONE: HoldEffect = { kind: "none" };

/** One step of the gesture. Total: every event is legal in every phase, because
 *  pointer streams are not, a pointerup can arrive with no matching down after
 *  a drag out of the window, and a timer can fire into a phase that has already
 *  moved on. */
export function holdStep(state: HoldPhase, ev: HoldEvent): { next: HoldPhase; effect: HoldEffect } {
  switch (ev.type) {
    case "press":
      // A press while a flyout is open is first and foremost a DISMISS. On the
      // button that owns the open flyout it is only that, otherwise the same
      // press would close the menu and immediately run the tool underneath it,
      // so tapping a button to change your mind would draw something. On any
      // other button the dismiss is free and the press starts normally, because
      // needing two clicks to move from one open flyout to the next button is
      // the thing that makes palettes feel sticky.
      if (state.phase === "open") {
        if (state.groupId === ev.groupId) return { next: IDLE, effect: { kind: "close" } };
        return {
          next: { phase: "pressing", groupId: ev.groupId, hasVariants: ev.hasVariants },
          effect: { kind: "close" },
        };
      }
      return {
        next: { phase: "pressing", groupId: ev.groupId, hasVariants: ev.hasVariants },
        effect: NONE,
      };

    case "hold":
      // Opening is the WHOLE effect: no runDefault now, and none on the release
      // that follows, because the phase is no longer `pressing`.
      if (state.phase !== "pressing") return { next: state, effect: NONE }; // stale timer
      if (!state.hasVariants) return { next: state, effect: NONE }; // nothing to show; the click still stands
      return { next: { phase: "open", groupId: state.groupId }, effect: { kind: "open", groupId: state.groupId } };

    case "release":
      if (state.phase === "pressing") {
        // Under the threshold: an ordinary click on the face.
        return { next: IDLE, effect: { kind: "runDefault", groupId: state.groupId } };
      }
      if (state.phase === "open") {
        // Released over a row of THIS flyout: that is the pick. The groupId
        // check is not paranoia about stale rows so much as about a second
        // flyout's markup outliving a fast switch between two buttons.
        if (ev.over && ev.over.groupId === state.groupId) {
          return { next: IDLE, effect: { kind: "pick", groupId: state.groupId, action: ev.over.action } };
        }
        // Released anywhere else: the gesture is abandoned. Nothing runs, this
        // is how you back out after seeing what the variants are.
        return { next: IDLE, effect: { kind: "close" } };
      }
      return { next: IDLE, effect: NONE };

    case "contextmenu":
      // Right-click never runs a tool, in any phase. On a group with no
      // variants there is nothing to show, so it only clears whatever was up.
      if (!ev.hasVariants) {
        return { next: IDLE, effect: state.phase === "open" ? { kind: "close" } : NONE };
      }
      return { next: { phase: "open", groupId: ev.groupId }, effect: { kind: "open", groupId: ev.groupId } };

    case "cancel":
      return { next: IDLE, effect: state.phase === "open" ? { kind: "close" } : NONE };
  }
}
