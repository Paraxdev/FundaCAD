import { describe, expect, it } from "vitest";
import { chooseTracer, type NativeProbe } from "../../src/viewport/pathtrace/choose";

const software: NativeProbe = { available: true, path: "software", denoise: true };
const rayquery: NativeProbe = { available: true, path: "rayquery", denoise: true };
const none: NativeProbe = { available: false, reason: "no adapter" };

describe("tracer backend choice", () => {
  it("is native on Auto where WebGPU is missing (Linux, macOS 14/15)", () => {
    expect(chooseTracer("auto", { webgpu: false, native: software })).toBe("native");
    expect(chooseTracer("auto", { webgpu: false, native: rayquery })).toBe("native");
  });

  it("is native on Auto beside WebGPU only on the ray query path with its denoise", () => {
    expect(chooseTracer("auto", { webgpu: true, native: rayquery })).toBe("native");
    expect(chooseTracer("auto", { webgpu: true, native: software })).toBe("webgpu");
    expect(chooseTracer("auto", { webgpu: true, native: { ...rayquery, denoise: false } })).toBe("webgpu");
    expect(chooseTracer("auto", { webgpu: true, native: none })).toBe("webgpu");
  });

  it("follows the preference and falls back to the other backend", () => {
    expect(chooseTracer("native", { webgpu: true, native: software })).toBe("native");
    expect(chooseTracer("webgpu", { webgpu: true, native: rayquery })).toBe("webgpu");
    expect(chooseTracer("native", { webgpu: true, native: none })).toBe("webgpu");
    expect(chooseTracer("webgpu", { webgpu: false, native: software })).toBe("native");
    expect(chooseTracer("native", { webgpu: false, native: none })).toBeNull();
  });

  it("moves to the other backend after a fault, retries the only one, and stops after both", () => {
    expect(chooseTracer("auto", { webgpu: false, native: software, faulted: new Set(["native"]) })).toBe("native");
    expect(chooseTracer("auto", { webgpu: true, native: rayquery, faulted: new Set(["native"]) })).toBe("webgpu");
    expect(chooseTracer("webgpu", { webgpu: true, native: software, faulted: new Set(["webgpu"]) })).toBe("native");
    expect(chooseTracer("auto", { webgpu: true, native: software, faulted: new Set(["webgpu", "native"]) })).toBeNull();
  });
});

describe("native tracer probe", () => {
  it("says none outside the app, and none when the app does not answer", async () => {
    const { probeNative } = await import("../../src/viewport/pathtrace/probe");
    expect((await probeNative()).available).toBe(false);
    const stuck = await probeNative(() => new Promise(() => {}), 10);
    expect(stuck).toEqual({ available: false, reason: "the probe did not answer" });
    const refused = await probeNative(async () => { throw new Error("no adapter"); });
    expect(refused.available).toBe(false);
    expect(await probeNative(async () => software)).toEqual(software);
  });
});
