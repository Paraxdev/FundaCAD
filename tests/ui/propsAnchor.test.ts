// Where the feature-values popover lands over the bottom history strip.
//
// It used to follow the selected chip, which meant it moved whenever the strip
// scrolled and had to be clamped at both edges. It holds one berth now, against
// the right edge and above the strip, and only its contents change — so what is
// checked here is that the berth does NOT move for anything the history does,
// and still gets out of the way of the one piece of furniture that can share
// its column.

import { describe, expect, it } from "vitest";
import { anchorPanel } from "../../src/ui/propsAnchor";

const VIEW = { width: 1000, height: 800 };
const strip = (top = 740) => ({ left: 0, right: VIEW.width, top });

describe("anchorPanel", () => {
  it("parks against the right edge, above the strip", () => {
    const a = anchorPanel(strip(), VIEW, 248);
    expect(a.left).toBe(1000 - 8 - 248);
    expect(a.left + 248).toBe(1000 - 8);
    // 800 - 740 + 8: the strip's top edge plus the gap, measured from the
    // bottom of the window because that is the edge the panel grows away from.
    expect(a.bottom).toBe(68);
  });

  it("is the same berth whatever the history is doing", () => {
    // THE CONTROL for the whole change. The strip's own rect is the only input
    // that varies with the history, and scrolling it does not move that rect —
    // so a scrolled strip, a longer one, and a fresh one all anchor identically.
    const a = anchorPanel(strip(), VIEW, 248);
    for (const again of [anchorPanel(strip(), VIEW, 248), anchorPanel(strip(), VIEW, 248)]) {
      expect(again).toEqual(a);
    }
  });

  it("keeps the panel on screen when the window is narrower than the panel", () => {
    const a = anchorPanel(strip(), { width: 200, height: 800 }, 248);
    expect(a.left).toBe(8);
    expect(a.left).toBeGreaterThanOrEqual(0);
  });

  it("follows the strip's height, so a taller strip pushes it up", () => {
    expect(anchorPanel(strip(700), VIEW, 248).bottom).toBe(108);
  });

  describe("furniture it must not cover", () => {
    // The view-control pill sits at the bottom-left of the viewport, so at any
    // ordinary width the berth is already clear of it — which is most of the
    // point of moving to the right edge.
    const pill = { left: 248, right: 700, top: 690 };

    it("stays tight against the strip, clear of a pill on the other side", () => {
      expect(anchorPanel(strip(), VIEW, 248, 8, 8, pill).bottom).toBe(68);
    });

    it("still lifts over the pill in a window too narrow to avoid it", () => {
      // 600px wide puts the berth at left 344, inside the pill's 248..700.
      const a = anchorPanel(strip(), { width: 600, height: 800 }, 248, 8, 8, pill);
      expect(a.left).toBe(600 - 8 - 248);
      expect(a.bottom).toBe(800 - 690 + 8);
    });

    it("does not lift for a panel that merely touches the pill's edge", () => {
      const touching = { left: 1000 - 8 - 248, right: 1000, top: 690 };
      const a = anchorPanel(strip(), VIEW, 248, 8, 8, { ...touching, right: touching.left });
      expect(a.bottom).toBe(68);
    });

    it("ignores furniture that is below the strip anyway", () => {
      expect(anchorPanel(strip(600), VIEW, 248, 8, 8, pill).bottom).toBe(800 - 600 + 8);
    });

    it("behaves the same with no furniture at all", () => {
      expect(anchorPanel(strip(), VIEW, 248, 8, 8, null).bottom).toBe(68);
      expect(anchorPanel(strip(), VIEW, 248).bottom).toBe(68);
    });
  });

  it("never anchors below the bottom of the window", () => {
    // A strip reported at or past the bottom edge (mid-transition, a stale
    // rect) would otherwise produce a negative offset and park the panel off
    // screen with no way to reach it.
    expect(anchorPanel(strip(900), VIEW, 248).bottom).toBe(8);
  });
});
