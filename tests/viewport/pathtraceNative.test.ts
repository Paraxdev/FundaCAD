import { describe, expect, it, vi } from "vitest";
import { NativeTracer, type Blit, type FrameLink, type NativeFrame } from "../../src/viewport/pathtrace/nativeTracer";

class FakeLink implements FrameLink {
  readonly kind = "fake";
  queue: { generation: number; width: number; height: number }[] = [];
  log: string[] = [];
  seq = 0;
  resizeTo = 0;
  async next(): Promise<NativeFrame> {
    const f = this.queue.shift() ?? { generation: 1, width: 2, height: 2 };
    const seq = ++this.seq;
    return {
      ...f,
      seq,
      pixels: new Uint8Array(f.width * f.height * 4).fill(seq),
      release: () => this.log.push(`release ${seq}`),
    };
  }
  async resize() {
    return this.resizeTo;
  }
  close() {
    this.log.push("close");
  }
}

function setup(link: FakeLink, generation = 1) {
  const uploads: number[] = [];
  const blit = (log: string[]): Blit => ({
    maxTextureSize: 4096,
    upload: (f) => {
      uploads.push(f.seq);
      log.push(`upload ${f.seq}`);
    },
    dispose: () => {},
  });
  const canvas = { style: {} as Record<string, string>, remove() {} } as unknown as HTMLCanvasElement;
  const t = new NativeTracer({
    canvas,
    blit: () => blit(link.log),
    connect: async () => ({ link, generation, source: "test" }),
  });
  return { t, uploads };
}

describe("the native tracer backend", () => {
  it("uploads a frame into its canvas and counts it as a sample", async () => {
    const link = new FakeLink();
    const { t, uploads } = setup(link);
    await t.init();
    await t.renderSample(0);
    expect(uploads).toEqual([1]);
    expect(await t.samples()).toBe(1);
    expect(t.name).toBe("native fake (test)");
  });

  it("ignores a frame of an old generation and still releases it", async () => {
    const link = new FakeLink();
    link.queue = [
      { generation: 1, width: 2, height: 2 },
      { generation: 2, width: 3, height: 1 },
    ];
    const { t, uploads } = setup(link, 2);
    await t.init();
    await t.renderSample(0);
    expect(uploads).toEqual([]);
    expect(link.log).toContain("release 1");
    await t.renderSample(0);
    expect(uploads).toEqual([2]);
  });

  it("releases each slot once, after its upload, with a second frame in flight", async () => {
    const link = new FakeLink();
    const next = vi.spyOn(link, "next");
    const { t } = setup(link);
    await t.init();
    for (let i = 0; i < 3; i++) await t.renderSample(i);
    expect(link.log).toEqual(["upload 1", "release 1", "upload 2", "release 2", "upload 3", "release 3"]);
    // Frame 4 was asked for while frame 3 uploaded.
    expect(next).toHaveBeenCalledTimes(4);
    t.dispose();
    expect(link.log.at(-1)).toBe("close");
  });

  it("drops frames older than a resize once the app answers it", async () => {
    vi.useFakeTimers();
    try {
      const link = new FakeLink();
      link.resizeTo = 5;
      const { t, uploads } = setup(link);
      await t.init();
      t.setSize(100, 50, 1);
      await vi.advanceTimersByTimeAsync(200);
      await t.renderSample(0);
      expect(uploads).toEqual([]);
      link.queue = [{ generation: 5, width: 2, height: 2 }, { generation: 5, width: 2, height: 2 }];
      await t.renderSample(0);
      await t.renderSample(0);
      expect(uploads.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
