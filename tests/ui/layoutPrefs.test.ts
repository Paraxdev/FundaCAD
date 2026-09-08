// The gate, not the CSS. What matters here is that an untrusted stored value
// can never put the shell into an arrangement the stylesheet has no rule for,
// the failure mode of which is not an error but a blank column.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_LAYOUT,
  asHistorySide,
  asLayoutPrefs,
  asRibbonSide,
} from "../../src/ui/layoutPrefs";

describe("asRibbonSide / asHistorySide", () => {
  it("passes the known sides and refuses everything else", () => {
    expect(asRibbonSide("top")).toBe("top");
    expect(asRibbonSide("left")).toBe("left");
    expect(asHistorySide("bottom")).toBe("bottom");
    expect(asHistorySide("right")).toBe("right");
    // "right" is a valid HISTORY side and not a valid RIBBON one: the two gates
    // are separate on purpose, so widening one never quietly widens the other.
    for (const bad of ["right", "TOP", "", null, 0, {}, ["left"]]) {
      expect(asRibbonSide(bad)).toBeNull();
    }
    for (const bad of ["left", "Bottom", undefined, 1]) expect(asHistorySide(bad)).toBeNull();
  });
});

describe("asLayoutPrefs", () => {
  it("reads a well-formed object", () => {
    expect(asLayoutPrefs({ ribbon: "left", history: "right" })).toEqual({
      ribbon: "left",
      history: "right",
    });
  });

  it("sanitises PER FIELD, so one bad value costs only itself", () => {
    // The reason this is a map rather than a single value: a stored object that
    // has picked up a garbage `ribbon` must not also throw away the `history`
    // choice the user made separately.
    expect(asLayoutPrefs({ ribbon: "sideways", history: "right" })).toEqual({
      ribbon: DEFAULT_LAYOUT.ribbon,
      history: "right",
    });
  });

  it("fills in missing fields rather than returning a partial", () => {
    expect(asLayoutPrefs({})).toEqual(DEFAULT_LAYOUT);
    expect(asLayoutPrefs({ history: "right" }).ribbon).toBe(DEFAULT_LAYOUT.ribbon);
  });

  it("treats anything that is not an object as no setting at all", () => {
    for (const bad of [null, undefined, 42, "left", ["left"], true]) {
      expect(asLayoutPrefs(bad)).toEqual(DEFAULT_LAYOUT);
    }
  });

  it("hands back a fresh object each time", () => {
    // Callers compare identity to decide whether to redraw, and the defaults are
    // a module constant, returning it directly would let a caller mutate the
    // fallback every future read depends on.
    const a = asLayoutPrefs(null);
    expect(a).not.toBe(DEFAULT_LAYOUT);
    a.ribbon = "left";
    expect(DEFAULT_LAYOUT.ribbon).toBe("top");
  });
});
