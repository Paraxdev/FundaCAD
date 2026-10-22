// Press-and-hold on ribbon split buttons: a release runs the face tool, a hold opens the family and the row released
// over runs and becomes the face. Opening leaves `pressing`, so a hold never also runs the default.

/** A click (about 80-150 ms) can never trip it. The touch convention of about 500 ms is too slow for a toolbar used
 *  hundreds of times an hour. */
export const HOLD_MS = 300;

export type HoldPhase =
  | { phase: "idle" }
  /** `hasVariants` rides along so the machine answers the hold without the tool tables. */
  | { phase: "pressing"; groupId: string; hasVariants: boolean }
  /** Reached by holding, or straight away from a right-click. */
  | { phase: "open"; groupId: string };

export const IDLE: HoldPhase = { phase: "idle" };

export type HoldEvent =
  /** Primary-button pointerdown on a split button's face. */
  | { type: "press"; groupId: string; hasVariants: boolean }
  | { type: "hold" }
  /** Primary pointerup anywhere; `over` is the family row under the pointer, or null. */
  | { type: "release"; over: { groupId: string; action: string } | null }
  /** Right-click on a split button, for people who know the flyout is there and do not want to wait. */
  | { type: "contextmenu"; groupId: string; hasVariants: boolean }
  /** Escape, pointercancel, a press outside, losing the window. */
  | { type: "cancel" };

export type HoldEffect =
  | { kind: "none" }
  | { kind: "open"; groupId: string }
  | { kind: "close" }
  /** Leaves the default alone: a click is a use of it, not a vote for it. */
  | { kind: "runDefault"; groupId: string }
  /** Run this variant AND make it the group's new default. */
  | { kind: "pick"; groupId: string; action: string };

const NONE: HoldEffect = { kind: "none" };

/** Total: every event is legal in every phase, since a pointerup can arrive with no down after a drag out of the
 *  window and a timer can fire into a phase that moved on. */
export function holdStep(state: HoldPhase, ev: HoldEvent): { next: HoldPhase; effect: HoldEffect } {
  switch (ev.type) {
    case "press":
      // A press while open dismisses first. On the owning button it only dismisses, or changing your mind would draw
      // something; on another button the press also starts, so moving between flyouts takes one click.
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
      // Opening is the whole effect: the following release is no longer in `pressing`, so it runs nothing.
      if (state.phase !== "pressing") return { next: state, effect: NONE }; // stale timer
      if (!state.hasVariants) return { next: state, effect: NONE }; // nothing to show; the click still stands
      return { next: { phase: "open", groupId: state.groupId }, effect: { kind: "open", groupId: state.groupId } };

    case "release":
      if (state.phase === "pressing") {
        // Under the threshold: an ordinary click on the face.
        return { next: IDLE, effect: { kind: "runDefault", groupId: state.groupId } };
      }
      if (state.phase === "open") {
        // Released over a row of this flyout; the groupId check guards against stale markup after a fast switch.
        if (ev.over && ev.over.groupId === state.groupId) {
          return { next: IDLE, effect: { kind: "pick", groupId: state.groupId, action: ev.over.action } };
        }
        // Released elsewhere: abandoned, nothing runs. This is how you back out after seeing the variants.
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
