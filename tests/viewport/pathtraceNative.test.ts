import { describe, expect, it, vi } from "vitest";
import type { TracerBackend } from "../../src/viewport/pathtrace/backend";
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

function setup(link: FakeLink, generation = 1, call?: (cmd: string, args?: unknown) => Promise<unknown>) {
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
    call: call ?? (async (cmd) => (cmd === "pt_status" ? { samples: 1, fault: null } : undefined)),
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

  it("faults when the app has no tracer to report on instead of counting its own frames", async () => {
    const link = new FakeLink();
    const { t } = setup(link, 1, async (cmd) => {
      if (cmd === "pt_status") throw new Error("no native tracer on this machine");
    });
    const faults: string[] = [];
    t.onFault((why) => faults.push(why));
    await t.init();
    await t.renderSample(0);
    await expect(t.samples()).rejects.toThrow("no native tracer");
    expect(faults).toEqual(["The native tracer stopped: no native tracer on this machine"]);
  });

  describe("at the sample cap", () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const statuses = (list: object[], calls: string[]) => async (cmd: string, args?: unknown) => {
      calls.push(args ? `${cmd} ${JSON.stringify(args)}` : cmd);
      if (cmd !== "pt_status") return undefined;
      return { samples: 64, fault: null, denoised: false, denoising: false, denoiseError: null, ...((list.length > 1 ? list.shift() : list[0]) ?? {}) };
    };
    async function settle(t: NativeTracer) {
      let rounds = 0;
      while (t.present() && rounds++ < 20) await flush();
      return rounds;
    }

    it("waits for the native denoise, then pulls its frame past the raw prefetch", async () => {
      const link = new FakeLink();
      const calls: string[] = [];
      const { t, uploads } = setup(link, 1, statuses([{ denoising: true }, { denoising: true }, { denoised: true }], calls));
      await t.init();
      await t.renderSample(0);
      expect(t.denoised).toBe(false);
      expect(await settle(t)).toBeLessThan(20);
      expect(uploads).toEqual([1, 2, 3]);
      expect(t.denoised).toBe(true);
      expect(t.present()).toBe(false);
      t.reset();
      expect(t.denoised).toBe(false);
    });

    it("asks for a frame after a new level, so the native side starts that denoise", async () => {
      const link = new FakeLink();
      const calls: string[] = [];
      const { t, uploads } = setup(link, 1, statuses([{}, { denoising: true }, { denoised: true }], calls));
      await t.init();
      t.setDenoise("high");
      await settle(t);
      expect(calls).toContain('pt_denoise {"level":"high"}');
      expect(uploads).toEqual([1, 2, 3, 4]);
      expect(t.denoised).toBe(true);
    });

    it("settles on the raw frame where the app has no denoise", async () => {
      const link = new FakeLink();
      const { t } = setup(link, 1, statuses([{ denoiseError: "OpenImageDenoise.dll did not load" }], []));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await t.init();
      await t.renderSample(0);
      expect(await settle(t)).toBeLessThan(5);
      expect(t.denoised).toBe(false);
      expect(warn).toHaveBeenCalledWith("[native tracer] denoise: OpenImageDenoise.dll did not load");
      warn.mockRestore();
    });
  });
  describe("bloom", () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const glow = { strength: 0.252, radius: 0.48, threshold: 1.28 };
    const logged = (link: FakeLink, status: object = {}) => async (cmd: string, args?: unknown) => {
      link.log.push(args ? `${cmd} ${JSON.stringify(args)}` : cmd);
      if (cmd !== "pt_status") return undefined;
      return { samples: 64, fault: null, denoised: false, denoising: false, denoiseError: null, ...status };
    };
    const blooms = (link: FakeLink) => link.log.filter((l) => l.startsWith("pt_bloom"));

    it("is a whole TracerBackend", () => {
      const b: TracerBackend = setup(new FakeLink()).t;
      expect(typeof b.setBloom).toBe("function");
    });

    it("clears the shared native bloom on open and sends one set before it then", async () => {
      const link = new FakeLink();
      const { t } = setup(link, 1, logged(link));
      t.setBloom(glow);
      await flush();
      expect(blooms(link)).toEqual([]);
      await t.init();
      await flush();
      expect(blooms(link)).toEqual([`pt_bloom {"bloom":${JSON.stringify({ ...glow, side: 1 })}}`]);
      const other = new FakeLink();
      const b = setup(other, 1, logged(other)).t;
      await b.init();
      await flush();
      expect(blooms(other)).toEqual(['pt_bloom {"bloom":null}']);
    });

    it("sends a change once, with the bloom side of the canvas, and null for none", async () => {
      const link = new FakeLink();
      const { t } = setup(link, 1, logged(link));
      await t.init();
      t.setSize(800, 600, 2);
      t.setBloom(glow);
      t.setBloom({ ...glow });
      t.setBloom(null);
      await flush();
      expect(blooms(link)).toEqual([
        'pt_bloom {"bloom":null}',
        `pt_bloom {"bloom":${JSON.stringify({ ...glow, side: 800 })}}`,
        'pt_bloom {"bloom":null}',
      ]);
    });

    it("pulls the held frame again at the cap, after the change landed, and keeps the denoised state", async () => {
      const link = new FakeLink();
      const { t, uploads } = setup(link, 1, logged(link, { denoised: true }));
      await t.init();
      await t.renderSample(0);
      while (t.present()) await flush();
      expect(t.denoised).toBe(true);
      const before = uploads.length;
      t.setBloom(glow);
      for (let i = 0; i < 5; i++) await flush();
      expect(uploads.length).toBe(before + 2);
      const sent = link.log.findIndex((l) => l.startsWith("pt_bloom {\"bloom\":{"));
      expect(link.log.indexOf(`upload ${uploads[before + 1]}`)).toBeGreaterThan(sent);
      expect(t.denoised).toBe(true);
      expect(t.present()).toBe(false);
    });

    it("pulls nothing extra while tracing: the next frame carries the bloom", async () => {
      const link = new FakeLink();
      const { t, uploads } = setup(link, 1, logged(link));
      await t.init();
      await t.renderSample(0);
      t.setBloom(glow);
      for (let i = 0; i < 5; i++) await flush();
      expect(uploads).toEqual([1]);
    });
  });
});

describe("a traced picture on the native tracer", () => {
  function pictureCalls(answer: (cancelled: Promise<void>) => Promise<unknown>) {
    const calls: [string, unknown][] = [];
    let cancel!: () => void;
    const cancelled = new Promise<void>((r) => (cancel = r));
    const call = async (cmd: string, args?: unknown) => {
      calls.push([cmd, args]);
      if (cmd === "pt_status") return { samples: 1, fault: null, picture: { samples: 5, total: 8, denoising: false } };
      if (cmd === "pt_picture_cancel") cancel();
      if (cmd === "pt_picture") return answer(cancelled);
      return undefined;
    };
    return { calls, ...setup(new FakeLink(), 1, call) };
  }

  it("traces it with pt_picture, reports pt_status progress and answers the PNG as a data URL", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (b: ArrayBuffer) => void;
      const { t, calls } = pictureCalls(() => new Promise((r) => (finish = r)));
      await t.init();
      const seen: number[] = [];
      const p = t.picture({ width: 6, height: 4, samples: 8, onProgress: (n) => seen.push(n) });
      await vi.advanceTimersByTimeAsync(300);
      expect(seen).toEqual([5]);
      finish(new Uint8Array([137, 80, 78, 71]).buffer);
      await expect(p).resolves.toBe("data:image/png;base64,iVBORw==");
      expect(calls.find((c) => c[0] === "pt_picture")?.[1]).toEqual({ width: 6, height: 4, samples: 8 });
      expect(seen.at(-1)).toBe(8);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the native picture on abort and rejects as an AbortError", async () => {
    const { t, calls } = pictureCalls(async (cancelled) => {
      await cancelled;
      throw "the picture was cancelled";
    });
    await t.init();
    const ac = new AbortController();
    const p = t.picture({ width: 6, height: 4, samples: 8, signal: ac.signal });
    await new Promise((r) => setTimeout(r, 0));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(calls.map((c) => c[0])).toContain("pt_picture_cancel");
  });

  it("names why the native side refused the picture", async () => {
    const { t } = pictureCalls(async () => {
      throw "a 7680x4320 picture needs a 1013 MiB buffer";
    });
    await t.init();
    await expect(t.picture({ width: 7680, height: 4320, samples: 8 })).rejects.toThrow("needs a 1013 MiB buffer");
  });
});
