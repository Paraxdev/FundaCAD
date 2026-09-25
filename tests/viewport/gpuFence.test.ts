import { describe, expect, it } from "vitest";
import { GpuFence } from "../../src/viewport/gpuFence";

function fakeGl() {
  const live = new Set<object>();
  let signaled = false;
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1,
    SYNC_STATUS: 2,
    SIGNALED: 3,
    UNSIGNALED: 4,
    fenceSync: () => { const s = {}; live.add(s); return s; },
    deleteSync: (s: object) => { live.delete(s); },
    getSyncParameter: () => (signaled ? 3 : 4),
  };
  return { gl: gl as unknown as WebGL2RenderingContext, live, signal: (v: boolean) => { signaled = v; } };
}

describe("GpuFence", () => {
  it("is idle before anything was marked", () => {
    expect(new GpuFence(fakeGl().gl).idle()).toBe(true);
    expect(new GpuFence(null).idle()).toBe(true);
  });

  it("is busy until the marked frame has finished, then lets go of the sync", () => {
    const f = fakeGl();
    const fence = new GpuFence(f.gl);
    fence.mark();
    expect(fence.idle()).toBe(false);
    f.signal(true);
    expect(fence.idle()).toBe(true);
    expect(f.live.size).toBe(0);
  });

  it("keeps only the newest mark", () => {
    const f = fakeGl();
    const fence = new GpuFence(f.gl);
    fence.mark();
    fence.mark();
    fence.mark();
    expect(f.live.size).toBe(1);
  });
});
