import { beforeAll, describe, expect, it, vi } from "vitest";
import { sceneStats } from "../../src/diagnostics/sceneStats";

const base = { model: null, canvas: { clientWidth: 10, clientHeight: 10 } as HTMLCanvasElement, pixelRatio: 1, frameMs: null };

describe("sceneStats pass timings", () => {
  beforeAll(() => { vi.stubGlobal("window", {}); });

  it("lists the median per pass and how it was measured", () => {
    const out = sceneStats({ ...base, passes: { ms: { shadow: 0.5, main: 3.256 }, kind: "timer-query" } });
    expect(out).toContain("[passes] shadow 0.50 · main 3.26 ms (timer-query)");
  });

  it("says so before the first results arrive", () => {
    const out = sceneStats({ ...base, passes: { ms: {}, kind: "fence" } });
    expect(out).toContain("[passes] no GPU timings yet (fence)");
  });
});
