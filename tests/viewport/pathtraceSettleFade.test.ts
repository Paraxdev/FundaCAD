import { describe, expect, it } from "vitest";
import { CROSSFADE_MS } from "../../src/viewport/pathtrace/denoise";
import { SettleFade } from "../../src/viewport/pathtrace/settleFade";

describe("the fade from Realtime to the trace", () => {
  it("shows nothing before it starts", () => {
    const f = new SettleFade();
    expect(f.opacity(0)).toBe(0);
    expect(f.active(0)).toBe(false);
  });

  it("fades the Realtime picture out over the crossfade", () => {
    const f = new SettleFade();
    f.begin(1000);
    expect(f.opacity(1000)).toBe(1);
    expect(f.opacity(1000 + CROSSFADE_MS / 2)).toBeCloseTo(0.5);
    expect(f.active(1000 + CROSSFADE_MS - 1)).toBe(true);
    expect(f.opacity(1000 + CROSSFADE_MS)).toBe(0);
    expect(f.active(1000 + CROSSFADE_MS)).toBe(false);
  });

  it("is whole for a frame time read just before it began", () => {
    const f = new SettleFade();
    f.begin(1000);
    expect(f.opacity(995)).toBe(1);
  });

  it("ends at once when stopped, as when the view moves again", () => {
    const f = new SettleFade();
    f.begin(1000);
    f.stop();
    expect(f.opacity(1010)).toBe(0);
    expect(f.active(1010)).toBe(false);
  });
});
