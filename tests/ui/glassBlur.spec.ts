// The no-glass-blur class on <html>: on with potato mode, a software renderer or Solid panels,
// off again only when none holds. Solid panels also sets solid-panels, More and Maximum contrast imply it.
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_GLASS_BLUR_CLASS,
  SOLID_PANELS_CLASS,
  glassBlurOff,
  installGlassBlurSwitch,
  isSoftwareRendererName,
  setSoftwareRenderer,
} from "../../src/ui/glassBlur";
import { DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";
import { resetA11yPrefs, setA11yPref } from "../../src/ui/a11yPrefs";

const blurOff = () => document.documentElement.classList.contains(NO_GLASS_BLUR_CLASS);
const solid = () => document.documentElement.classList.contains(SOLID_PANELS_CLASS);

afterEach(() => {
  setRenderPref("potatoMode", false);
  setSoftwareRenderer(false);
  resetA11yPrefs();
});

describe("isSoftwareRendererName", () => {
  it("knows the software rasterisers and passes real GPUs", () => {
    expect(
      isSoftwareRendererName(
        "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
      ),
    ).toBe(true);
    expect(isSoftwareRendererName("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(isSoftwareRendererName("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)")).toBe(
      true,
    );
    expect(isSoftwareRendererName("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(
      false,
    );
    expect(isSoftwareRendererName("")).toBe(false);
  });
});

describe("glassBlurOff", () => {
  it("is on for potato mode or a software renderer, and only then", () => {
    expect(glassBlurOff(DEFAULT_RENDER, false)).toBe(false);
    expect(glassBlurOff({ ...DEFAULT_RENDER, performanceMode: true }, false)).toBe(false);
    expect(glassBlurOff({ ...DEFAULT_RENDER, potatoMode: true }, false)).toBe(true);
    expect(glassBlurOff(DEFAULT_RENDER, true)).toBe(true);
    expect(glassBlurOff(DEFAULT_RENDER, false, true)).toBe(true);
    expect(glassBlurOff(DEFAULT_RENDER, false, false)).toBe(false);
  });
});

describe("the class on <html>", () => {
  it("follows the potato pref and the detected renderer", () => {
    installGlassBlurSwitch();
    expect(blurOff()).toBe(false);

    setRenderPref("potatoMode", true);
    expect(blurOff()).toBe(true);
    setRenderPref("potatoMode", false);
    expect(blurOff()).toBe(false);

    setSoftwareRenderer(true);
    expect(blurOff()).toBe(true);
    setRenderPref("potatoMode", true);
    setRenderPref("potatoMode", false);
    expect(blurOff()).toBe(true);
    setSoftwareRenderer(false);
    expect(blurOff()).toBe(false);
  });
});

describe("Solid panels", () => {
  it("follow the setting and turn the blur off with it", () => {
    installGlassBlurSwitch();
    expect(solid()).toBe(false);
    setA11yPref("solidPanels", true);
    expect(solid()).toBe(true);
    expect(blurOff()).toBe(true);
    setA11yPref("solidPanels", false);
    expect(solid()).toBe(false);
    expect(blurOff()).toBe(false);
  });

  it("come with More and Maximum contrast and go with Standard", () => {
    installGlassBlurSwitch();
    setA11yPref("contrast", "more");
    expect(solid()).toBe(true);
    setA11yPref("contrast", "maximum");
    expect(solid()).toBe(true);
    expect(blurOff()).toBe(true);
    setA11yPref("contrast", "standard");
    expect(solid()).toBe(false);
    expect(blurOff()).toBe(false);
  });

  it("stay off for a software renderer, which only drops the blur", () => {
    installGlassBlurSwitch();
    setSoftwareRenderer(true);
    expect(blurOff()).toBe(true);
    expect(solid()).toBe(false);
  });
});
