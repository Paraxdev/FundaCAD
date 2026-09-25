// The no-glass-blur class on <html>: on with potato mode or a software renderer,
// off again only when neither holds.
import { afterEach, describe, expect, it } from "vitest";
import {
  NO_GLASS_BLUR_CLASS,
  glassBlurOff,
  installGlassBlurSwitch,
  isSoftwareRendererName,
  setSoftwareRenderer,
} from "../../src/ui/glassBlur";
import { DEFAULT_RENDER, setRenderPref } from "../../src/ui/renderPrefs";

const blurOff = () => document.documentElement.classList.contains(NO_GLASS_BLUR_CLASS);

afterEach(() => {
  setRenderPref("potatoMode", false);
  setSoftwareRenderer(false);
});

describe("isSoftwareRendererName", () => {
  it("knows the software rasterisers and passes real GPUs", () => {
    expect(isSoftwareRendererName("ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)")).toBe(true);
    expect(isSoftwareRendererName("llvmpipe (LLVM 15.0.7, 256 bits)")).toBe(true);
    expect(isSoftwareRendererName("ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)")).toBe(true);
    expect(isSoftwareRendererName("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)")).toBe(false);
    expect(isSoftwareRendererName("")).toBe(false);
  });
});

describe("glassBlurOff", () => {
  it("is on for potato mode or a software renderer, and only then", () => {
    expect(glassBlurOff(DEFAULT_RENDER, false)).toBe(false);
    expect(glassBlurOff({ ...DEFAULT_RENDER, performanceMode: true }, false)).toBe(false);
    expect(glassBlurOff({ ...DEFAULT_RENDER, potatoMode: true }, false)).toBe(true);
    expect(glassBlurOff(DEFAULT_RENDER, true)).toBe(true);
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
