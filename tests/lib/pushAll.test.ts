import { describe, expect, it } from "vitest";
import { pushAll } from "../../src/lib/pushAll";

describe("pushAll", () => {
  it("appends arrays and typed arrays in order", () => {
    const out = [1];
    pushAll(out, [2, 3]);
    pushAll(out, new Float32Array([4, 5]));
    expect(out).toEqual([1, 2, 3, 4, 5]);
  });

  it("takes more entries than a spread call can pass as arguments", () => {
    const big = Array.from({ length: 400_000 }, (_, i) => i);
    expect(() => [].push(...(big as never[]))).toThrow(RangeError);
    const out: number[] = [];
    pushAll(out, big);
    expect(out).toHaveLength(400_000);
    expect(out[399_999]).toBe(399_999);
  });
});
