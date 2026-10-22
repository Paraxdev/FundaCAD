// The viewport render settings: per-field sanitising of an untrusted stored
// value, and clamping rather than refusing a number.
//
// Modelled on tests/ui/layoutPrefs.test.ts, and here for the same reason: the
// value comes out of localStorage, where anything at all may be, and the failure
// mode of getting it wrong is a viewport that will not draw.

import { describe, expect, it } from "vitest";
import {
  BACKGROUND_COLOR,
  DEFAULT_BLOOM,
  DEFAULT_RENDER,
  MAX_BRIGHTNESS,
  MAX_EMISSIVE_INTENSITY,
  MIN_BRIGHTNESS,
  asBackground,
  asBloom,
  bloomSettings,
  asBrightness,
  asEnvironment,
  asRealtimeQuality,
  asRenderPrefs,
  asTangentEdges,
  onRenderPrefsChange,
  performanceModeOn,
  renderPrefs,
  setRenderPref,
} from "../../src/ui/renderPrefs";
import { cameraFlightsOn, motionOn } from "../../src/ui/motion";

describe("the field gates", () => {
  it("take what they know and refuse the rest", () => {
    expect(asEnvironment("studio")).toBe("studio");
    expect(asEnvironment("hdri")).toBeNull();
    expect(asBackground("grey")).toBe("grey");
    expect(asBackground("chartreuse")).toBeNull();
    expect(asTangentEdges("hide")).toBe("hide");
    expect(asTangentEdges(true)).toBeNull();
  });

  it("clamp a brightness instead of throwing it away", () => {
    expect(asBrightness(1.5)).toBe(1.5);
    expect(asBrightness(99)).toBe(MAX_BRIGHTNESS);
    expect(asBrightness(-4)).toBe(MIN_BRIGHTNESS);
    // Not a number at all is a different answer from out of range: there is
    // nothing to clamp towards, so it falls back to the default.
    expect(asBrightness("1.5")).toBeNull();
    expect(asBrightness(Number.NaN)).toBeNull();
    expect(asBrightness(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("asRenderPrefs", () => {
  it("sanitises PER FIELD, so one bad value costs only itself", () => {
    expect(
      asRenderPrefs({
        environment: "nonsense",
        background: "grey",
        brightness: 1.4,
        bloom: 0.7,
        performanceMode: true,
      }),
    ).toEqual({
      environment: DEFAULT_RENDER.environment,
      envRotation: DEFAULT_RENDER.envRotation,
      envExposure: DEFAULT_RENDER.envExposure,
      envBackground: DEFAULT_RENDER.envBackground,
      background: "grey",
      brightness: 1.4,
      bloom: 0.7,
      fov: DEFAULT_RENDER.fov,
      aperture: DEFAULT_RENDER.aperture,
      focusBlur: DEFAULT_RENDER.focusBlur,
      performanceMode: true,
      potatoMode: DEFAULT_RENDER.potatoMode,
      shadows: DEFAULT_RENDER.shadows,
      tangentEdges: DEFAULT_RENDER.tangentEdges,
      keyAzimuth: DEFAULT_RENDER.keyAzimuth,
      keyElevation: DEFAULT_RENDER.keyElevation,
      viewModeModel: DEFAULT_RENDER.viewModeModel,
      viewModeRender: DEFAULT_RENDER.viewModeRender,
      overlaysModel: DEFAULT_RENDER.overlaysModel,
      overlaysRender: DEFAULT_RENDER.overlaysRender,
      groundModel: DEFAULT_RENDER.groundModel,
      groundRender: DEFAULT_RENDER.groundRender,
      matcapStyle: DEFAULT_RENDER.matcapStyle,
      matcapTint: DEFAULT_RENDER.matcapTint,
      denoise: DEFAULT_RENDER.denoise,
      tracer: DEFAULT_RENDER.tracer,
      realtimeQuality: DEFAULT_RENDER.realtimeQuality,
      realtimeWhileMoving: DEFAULT_RENDER.realtimeWhileMoving,
    });
  });

  it("keeps performance mode only as a real boolean", () => {
    // A non-boolean (an old truthy "on" string, say) must not slip through as
    // the render tier, it decides glass vs alpha and the pixel ratio.
    expect(asRenderPrefs({ performanceMode: "yes" }).performanceMode).toBe(false);
    expect(asRenderPrefs({ performanceMode: true }).performanceMode).toBe(true);
  });

  it("fills in a field a stored setting predates", () => {
    // Every user who has ever changed a render setting has a stored object
    // written before this field existed, and it must read as the default rather
    // than as undefined, which would reach the renderer as "no such level".
    expect(asRenderPrefs({ environment: "none", background: "dark", brightness: 1 }).bloom).toBe(DEFAULT_RENDER.bloom);
  });

  it("falls back whole for anything that is not an object", () => {
    for (const bad of [null, undefined, 7, "studio", [1, 2]]) {
      expect(asRenderPrefs(bad)).toEqual(DEFAULT_RENDER);
    }
  });
});

describe("the defaults", () => {
  it("keep reflections ON, which is what makes a metal look like metal", () => {
    // Not a preference dressed as a default. A physically-based metal is almost
    // all reflection, so with no environment it renders near black, and the
    // whole material library is unreadable. Turning it off is a choice; having
    // it off out of the box would look like a bug.
    expect(DEFAULT_RENDER.environment).toBe("studio");
    expect(DEFAULT_RENDER.brightness).toBe(1);
  });

  it("gives every fixed background a colour, and the theme one none", () => {
    expect(Object.keys(BACKGROUND_COLOR).sort()).toEqual(["dark", "grey", "light"]);
    expect("theme" in BACKGROUND_COLOR).toBe(false);
  });
});

describe("bloom", () => {
  it("clamps the amount into 0..1 and migrates the old named levels", () => {
    expect(asBloom(0)).toBe(0);
    expect(asBloom(0.6)).toBe(0.6);
    expect(asBloom(5)).toBe(1); // clamped
    expect(asBloom(-2)).toBe(0);
    // documents written before the slider existed
    expect(asBloom("off")).toBe(0);
    expect(asBloom("subtle")).toBe(DEFAULT_BLOOM);
    expect(asBloom("strong")).toBe(1);
    for (const bad of ["SUBTLE", "", null, undefined, {}, [1]]) {
      expect(asBloom(bad)).toBeNull();
    }
  });

  it("only spills light above full brightness in the lower half of the slider", () => {
    // THE tuning, and the reason it is safe to leave bloom on by default. The
    // pass runs on the LINEAR image before tone mapping, where an ordinary white
    // part under a key light at intensity 2 already sits above 1: measured at a
    // threshold of 0.85 the white test cylinder haloed as hard as the lit one and
    // the whole viewport went pale.
    expect(bloomSettings(DEFAULT_BLOOM).threshold).toBeGreaterThan(1);
    // ...and the top of the slider reaches an ordinary highlight, or it would be
    // a second name for the same picture: threshold falls and strength rises.
    expect(bloomSettings(1).threshold).toBeLessThan(bloomSettings(DEFAULT_BLOOM).threshold);
    expect(bloomSettings(1).strength).toBeGreaterThan(bloomSettings(DEFAULT_BLOOM).strength);
    // off is genuinely off
    expect(bloomSettings(0).strength).toBe(0);
  });

  it("lets the Emission slider reach past the default bloom threshold", () => {
    // CONTROL on the numbers being set independently: if the slider could not
    // push a material past the threshold, its top end would do visibly nothing
    // and an emissive material would never bloom at all, which is the only thing
    // bloom is for.
    expect(MAX_EMISSIVE_INTENSITY).toBeGreaterThan(bloomSettings(DEFAULT_BLOOM).threshold);
  });
});

describe("potato mode", () => {
  it("is off by default and kept only as a real boolean", () => {
    expect(DEFAULT_RENDER.potatoMode).toBe(false);
    expect(asRenderPrefs({ potatoMode: "yes" }).potatoMode).toBe(false);
    expect(asRenderPrefs({ potatoMode: true }).potatoMode).toBe(true);
    expect(asRenderPrefs({ performanceMode: true }).potatoMode).toBe(false);
  });

  it("implies performance mode without writing it", () => {
    expect(performanceModeOn({ ...DEFAULT_RENDER, potatoMode: true })).toBe(true);
    expect(performanceModeOn({ ...DEFAULT_RENDER, performanceMode: true })).toBe(true);
    expect(performanceModeOn(DEFAULT_RENDER)).toBe(false);
  });

  it("restores performance mode as it was when turned off", () => {
    for (const before of [false, true]) {
      setRenderPref("performanceMode", before);
      setRenderPref("potatoMode", true);
      expect(renderPrefs().potatoMode).toBe(true);
      expect(performanceModeOn()).toBe(true);
      expect(renderPrefs().performanceMode).toBe(before);
      setRenderPref("potatoMode", false);
      expect(performanceModeOn()).toBe(before);
      expect(renderPrefs()).toEqual({ ...DEFAULT_RENDER, performanceMode: before });
    }
    setRenderPref("performanceMode", false);
    expect(renderPrefs()).toEqual(DEFAULT_RENDER);
  });

  it("tells the viewport on every flip and refuses a non-boolean", () => {
    let calls = 0;
    const off = onRenderPrefsChange(() => {
      calls++;
    });
    setRenderPref("potatoMode", true);
    setRenderPref("potatoMode", true);
    setRenderPref("potatoMode", "on" as unknown as boolean);
    expect(renderPrefs().potatoMode).toBe(true);
    setRenderPref("potatoMode", false);
    off();
    expect(calls).toBe(2);
  });

  it("makes the camera jump instead of fly", () => {
    const flights = motionOn();
    setRenderPref("potatoMode", true);
    expect(cameraFlightsOn()).toBe(false);
    setRenderPref("potatoMode", false);
    expect(cameraFlightsOn()).toBe(flights);
  });
});

describe("matcap look", () => {
  it("keeps a known style and a real boolean, and falls back otherwise", () => {
    expect(asRenderPrefs({ matcapStyle: "wax", matcapTint: false })).toMatchObject({
      matcapStyle: "wax",
      matcapTint: false,
    });
    const bad = asRenderPrefs({ matcapStyle: "chrome", matcapTint: "no" });
    expect(bad.matcapStyle).toBe(DEFAULT_RENDER.matcapStyle);
    expect(bad.matcapTint).toBe(DEFAULT_RENDER.matcapTint);
  });

  it("saves a choice per user and refuses a bad one", () => {
    setRenderPref("matcapStyle", "metal");
    setRenderPref("matcapTint", false);
    expect(renderPrefs()).toMatchObject({ matcapStyle: "metal", matcapTint: false });
    setRenderPref("matcapStyle", "nope" as never);
    expect(renderPrefs().matcapStyle).toBe("metal");
    setRenderPref("matcapStyle", DEFAULT_RENDER.matcapStyle);
    setRenderPref("matcapTint", DEFAULT_RENDER.matcapTint);
  });
});

describe("path traced denoise", () => {
  it("defaults to the standard weights and keeps only a known level", () => {
    expect(DEFAULT_RENDER.denoise).toBe("standard");
    expect(asRenderPrefs({ denoise: "high" }).denoise).toBe("high");
    expect(asRenderPrefs({ denoise: "ultra" }).denoise).toBe("standard");
    setRenderPref("denoise", "off");
    expect(renderPrefs().denoise).toBe("off");
    setRenderPref("denoise", "max" as never);
    expect(renderPrefs().denoise).toBe("off");
    setRenderPref("denoise", DEFAULT_RENDER.denoise);
  });
});

describe("path traced realtime while moving", () => {
  it("defaults to on and keeps only a real boolean", () => {
    expect(DEFAULT_RENDER.realtimeWhileMoving).toBe(true);
    expect(asRenderPrefs({ realtimeWhileMoving: false }).realtimeWhileMoving).toBe(false);
    expect(asRenderPrefs({ realtimeWhileMoving: "off" }).realtimeWhileMoving).toBe(true);
    expect(asRenderPrefs({}).realtimeWhileMoving).toBe(true);
  });

  it("is remembered in the stored settings", () => {
    setRenderPref("realtimeWhileMoving", false);
    expect(renderPrefs().realtimeWhileMoving).toBe(false);
    expect(asRenderPrefs(JSON.parse(JSON.stringify(renderPrefs()))).realtimeWhileMoving).toBe(false);
    setRenderPref("realtimeWhileMoving", "no" as never);
    expect(renderPrefs().realtimeWhileMoving).toBe(false);
    setRenderPref("realtimeWhileMoving", DEFAULT_RENDER.realtimeWhileMoving);
  });
});

describe("path traced backend", () => {
  it("defaults to Auto and keeps only Auto, Native or WebGPU", () => {
    expect(DEFAULT_RENDER.tracer).toBe("auto");
    expect(asRenderPrefs({ tracer: "native" }).tracer).toBe("native");
    expect(asRenderPrefs({ tracer: "cuda" }).tracer).toBe("auto");
    setRenderPref("tracer", "webgpu");
    expect(renderPrefs().tracer).toBe("webgpu");
    setRenderPref("tracer", "metal" as never);
    expect(renderPrefs().tracer).toBe("webgpu");
    setRenderPref("tracer", DEFAULT_RENDER.tracer);
  });
});

describe("realtime quality", () => {
  it("defaults to Auto and keeps only Auto, Standard or High", () => {
    expect(DEFAULT_RENDER.realtimeQuality).toBe("auto");
    expect(asRealtimeQuality("high")).toBe("high");
    expect(asRealtimeQuality("standard")).toBe("standard");
    expect(asRealtimeQuality("auto")).toBe("auto");
    for (const v of ["ultra", "High", "", 1, true, null, undefined, {}, ["high"]])
      expect(asRealtimeQuality(v)).toBeNull();
  });

  it("falls back to Auto for a saved object without it or with a wrong type", () => {
    expect(asRenderPrefs({ bloom: 0.5 }).realtimeQuality).toBe("auto");
    expect(asRenderPrefs({ realtimeQuality: 2 }).realtimeQuality).toBe("auto");
    expect(asRenderPrefs({ realtimeQuality: "max" }).realtimeQuality).toBe("auto");
    expect(asRenderPrefs({ realtimeQuality: "high" }).realtimeQuality).toBe("high");
  });

  it("is written through setRenderPref and refuses an unknown value", () => {
    setRenderPref("realtimeQuality", "high");
    expect(renderPrefs().realtimeQuality).toBe("high");
    setRenderPref("realtimeQuality", "ultra" as never);
    expect(renderPrefs().realtimeQuality).toBe("high");
    setRenderPref("realtimeQuality", DEFAULT_RENDER.realtimeQuality);
    expect(renderPrefs().realtimeQuality).toBe("auto");
  });
});

describe("ground", () => {
  it("is none in both workspaces by default, like shadows", () => {
    expect(DEFAULT_RENDER.groundModel).toBe("none");
    expect(DEFAULT_RENDER.groundRender).toBe("none");
    expect(DEFAULT_RENDER.shadows).toBe(false);
  });

  it("keeps only none or shadow per field", () => {
    expect(asRenderPrefs({ groundModel: "shadow", groundRender: 7 })).toMatchObject({
      groundModel: "shadow",
      groundRender: "none",
    });
    for (const bad of ["Shadow", null, {}, true, "reflection"]) {
      expect(asRenderPrefs({ groundModel: bad, groundRender: bad })).toMatchObject({
        groundModel: "none",
        groundRender: "none",
      });
    }
  });

  it("saves a choice and refuses a bad one", () => {
    setRenderPref("groundRender", "shadow");
    expect(renderPrefs().groundRender).toBe("shadow");
    expect(renderPrefs().groundModel).toBe("none");
    setRenderPref("groundRender", "bogus" as never);
    expect(renderPrefs().groundRender).toBe("shadow");
    setRenderPref("groundRender", DEFAULT_RENDER.groundRender);
  });
});
