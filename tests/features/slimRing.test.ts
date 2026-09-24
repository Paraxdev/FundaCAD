import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  createSlimRing,
  ringLook,
  RING_BACK_OPACITY,
  RING_BAND,
  RING_DRAG_BACK_OPACITY,
  RING_IDLE_OPACITY,
} from "../../src/features/slimRing";

const RINGS = [0, 1, 2] as const;

describe("ringLook", () => {
  it("draws every ring thin and faint with nothing under the hand", () => {
    for (const r of RINGS) expect(ringLook(r, null, null, RINGS)).toEqual({ thick: false, opacity: RING_IDLE_OPACITY, held: false });
  });

  it("lights and thickens only the hovered ring, the others step back", () => {
    expect(ringLook(1, 1, null, RINGS)).toEqual({ thick: true, opacity: 1, held: false });
    expect(ringLook(0, 1, null, RINGS)).toEqual({ thick: false, opacity: RING_BACK_OPACITY, held: false });
    expect(ringLook(2, 1, null, RINGS)).toEqual({ thick: false, opacity: RING_BACK_OPACITY, held: false });
  });

  it("while a ring is held it alone stands, whatever the cursor crosses", () => {
    expect(ringLook(2, 0, 2, RINGS)).toEqual({ thick: true, opacity: 1, held: true });
    expect(ringLook(0, 0, 2, RINGS)).toEqual({ thick: false, opacity: RING_DRAG_BACK_OPACITY, held: false });
  });

  it("leaves the rings alone for a handle that is not a ring", () => {
    const turns = ["tiltX", "tiltY", "spin"] as const;
    expect(ringLook<string>("tiltX", "offset", null, turns)).toEqual({ thick: false, opacity: RING_IDLE_OPACITY, held: false });
    expect(ringLook<string>("tiltX", "tiltX", "offset", turns)).toEqual({ thick: false, opacity: RING_IDLE_OPACITY, held: false });
  });
});

describe("createSlimRing", () => {
  it("is grabbed by a band far wider than the line it draws", () => {
    const r = createSlimRing(46);
    expect((r.band.geometry as THREE.TorusGeometry).parameters.tube).toBe(RING_BAND);
    expect(RING_BAND).toBeGreaterThanOrEqual(8);
    expect((r.band.material as { visible: boolean }).visible).toBe(false);
    r.dispose();
  });

  it("swaps the thin line for the thick one when painted hot", () => {
    const r = createSlimRing(46);
    const thin = r.drawn();
    r.paint({ thick: true, opacity: 1, held: false }, 0xff0000);
    expect(r.drawn()).not.toBe(thin);
    r.paint({ thick: false, opacity: RING_IDLE_OPACITY, held: false }, 0xff0000);
    expect(r.drawn()).toBe(thin);
    r.dispose();
  });
});
