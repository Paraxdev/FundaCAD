// Tilting the puck forward and back also zoomed.
//
// A real 6DOF puck leaks a few counts onto neighbouring axes under a hard
// deflection. The measured leak is ~30 counts of push/pull during a ~200-count
// tilt, which clears the 24-count deadzone and drives a genuine, continuous
// zoom, because the deadzone is per-axis and ABSOLUTE: an axis is never
// compared against the other axes of the same gesture.
//
// filterMotion is the one place that comparison happens, and it is the single
// source of truth shared by the viewport motion loop and the settings preview
// (they used to carry a deadzone each, so they could disagree).
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  filterMotion,
  getSpaceMouseConfig,
  setSpaceMouseConfig,
  type Motion,
  type SpaceMouseConfig,
} from "../../src/input/spacemouse";

const mot = (p: Partial<Motion>): Motion => ({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, ...p });

/** the live default config (no localStorage in this env, so it IS the defaults),
 *  with the two fields under test pinned explicitly */
function cfg(over: Partial<SpaceMouseConfig> = {}): SpaceMouseConfig {
  return { ...structuredClone(getSpaceMouseConfig()), deadzone: 24, crossAxis: 0.25, ...over };
}

describe("filterMotion — the cross-axis filter", () => {
  it("ships ON by default at a 24-count deadzone", () => {
    const d = getSpaceMouseConfig();
    expect(d.deadzone).toBe(24);
    expect(d.crossAxis).toBe(0.25);
  });

  it("drops a 30-count push/pull leak during a 200-count tilt", () => {
    const f = filterMotion(mot({ rx: 200, ty: 30 }), cfg());
    expect(f.ty).toBe(0); // the leak that was zooming
    expect(f.rx).toBe(200); // the tilt the user meant
  });

  it("keeps a pure 30-count push/pull, so a gentle zoom still zooms", () => {
    // THE CONTROL. The same 30 counts, on their own, are deliberate input — if
    // this went to 0 the filter would be an absolute deadzone in disguise.
    expect(filterMotion(mot({ ty: 30 }), cfg()).ty).toBe(30);
  });

  it("is a no-op beyond the deadzone when crossAxis is 0", () => {
    const m = mot({ rx: 200, ty: 30, tz: 10 });
    expect(filterMotion(m, cfg({ crossAxis: 0 }))).toEqual(mot({ rx: 200, ty: 30 }));
  });

  it("keeps an axis sitting exactly ON the gate", () => {
    // 50 is exactly 0.25 x 200 and the comparison is STRICT, so this axis is the
    // last one that survives: the only assertion here a `<=` would break.
    const f = filterMotion(mot({ rx: 200, ty: 50 }), cfg());
    expect(f.ty).toBe(50);
    expect(f.rx).toBe(200);
    expect(filterMotion(mot({ rx: 200, ty: 49 }), cfg()).ty).toBe(0);
  });

  it("keeps both axes of a genuine two-handed gesture", () => {
    const f = filterMotion(mot({ ty: 200, rx: 200 }), cfg());
    expect(f.ty).toBe(200);
    expect(f.rx).toBe(200);
  });

  it("does not let an UNMAPPED axis gate the mapped ones", () => {
    // Unbind ry, then deflect it hard: it must not silence the mapped tilt. rx
    // is deliberately 60, i.e. UNDER 0.25 x 300 — a peak taken over all six axes
    // would zero it, a peak taken over the mapped ones only keeps it.
    const c = cfg();
    c.bind.roll = { src: "rx", invert: false };
    expect(filterMotion(mot({ ry: 300, rx: 60 }), c).rx).toBe(60);
  });

  it("survives a config whose crossAxis is out of range", () => {
    // Defence in depth: even if something writes 5 straight into the live
    // config, the puck must not go completely dead.
    expect(filterMotion(mot({ rx: 200, ty: 30 }), cfg({ crossAxis: 5 })).rx).toBe(200);
  });
});

describe("crossAxis is clamped to [0, 0.9]", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  /** load the module fresh against a persisted config */
  async function loadWith(saved: Record<string, unknown>) {
    const store = new Map<string, string>([
      ["fundacad.spacemouse.config", JSON.stringify(saved)],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    });
    vi.resetModules();
    return (await import("../../src/input/spacemouse"));
  }

  it("clamps a persisted 5 down to 0.9", async () => {
    const m = await loadWith({ crossAxis: 5 });
    expect(m.getSpaceMouseConfig().crossAxis).toBe(0.9);
  });

  it("clamps a persisted -1 up to 0", async () => {
    const m = await loadWith({ crossAxis: -1 });
    expect(m.getSpaceMouseConfig().crossAxis).toBe(0);
  });

  it("clamps on set too, not just on load", () => {
    setSpaceMouseConfig({ crossAxis: 5 });
    expect(getSpaceMouseConfig().crossAxis).toBe(0.9);
    setSpaceMouseConfig({ crossAxis: 0.25 }); // restore for any later test
  });
});
