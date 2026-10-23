import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import type { TracerBackend } from "../../src/viewport/pathtrace/backend";
import { NativeTracer, type Blit, type FrameLink, type NativeFrame } from "../../src/viewport/pathtrace/nativeTracer";
import { halfEquirect } from "../../src/viewport/pathtrace/environment";
import type { TraceLook } from "../../src/viewport/pathtrace/backend";

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
      link.queue = [
        { generation: 5, width: 2, height: 2 },
        { generation: 5, width: 2, height: 2 },
      ];
      await t.renderSample(0);
      await t.renderSample(0);
      expect(uploads.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts no sample of the old size until a frame of the new size lands", async () => {
    vi.useFakeTimers();
    try {
      const link = new FakeLink();
      link.resizeTo = 5;
      const { t } = setup(link, 1, async (cmd) => (cmd === "pt_status" ? { samples: 256, fault: null } : undefined));
      await t.init();
      t.setSize(100, 50, 1);
      expect(await t.samples()).toBe(0);
      await t.renderSample(0);
      expect(await t.samples()).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(await t.samples()).toBe(0);
      link.queue = [
        { generation: 5, width: 2, height: 2 },
        { generation: 5, width: 2, height: 2 },
      ];
      // The prefetch was asked for before the resize.
      await t.renderSample(0);
      expect(await t.samples()).toBe(0);
      await t.renderSample(0);
      expect(await t.samples()).toBe(256);
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

  describe("a status asked while pt_* calls are queued", () => {
    const roomLook = (key: string): TraceLook => {
      const tex = halfEquirect(new Uint16Array(4 * 2 * 4), 4, 2);
      tex.userData.envKey = key;
      return {
        lights: [],
        background: new THREE.Color(),
        environment: tex,
        brightness: 1,
        toneMapping: THREE.NeutralToneMapping,
        exposure: 1,
      };
    };
    const slowEnv = () => {
      const order: string[] = [];
      let release!: () => void;
      const landed = new Promise<void>((r) => (release = r));
      const call = async (cmd: string) => {
        order.push(cmd);
        if (cmd === "pt_env") await landed;
        if (cmd === "pt_status") return { samples: 256, fault: null };
        return null;
      };
      return { order, release, ...setup(new FakeLink(), 1, call) };
    };

    it("counts no sample until the calls queued before it have landed", async () => {
      const { t, order, release } = slowEnv();
      await t.init();
      t.updateLook(roomLook("studio|h1"));
      const s = t.samples();
      await new Promise((r) => setTimeout(r, 10));
      expect(order.filter((c) => c.startsWith("pt_look") || c === "pt_env" || c === "pt_status")).toEqual([
        "pt_look",
        "pt_env",
      ]);
      release();
      expect(await s).toBe(256);
      expect(order.slice(-3)).toEqual(["pt_look", "pt_env", "pt_status"]);
    });

    it("answers 0 when a reset overtook it while it waited", async () => {
      const { t, release } = slowEnv();
      await t.init();
      t.updateLook(roomLook("studio|h1"));
      const s = t.samples();
      t.updateLook(roomLook("studio|h1"));
      release();
      expect(await s).toBe(0);
    });
  });

  describe("at the sample cap", () => {
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const statuses = (list: object[], calls: string[]) => async (cmd: string, args?: unknown) => {
      calls.push(args ? `${cmd} ${JSON.stringify(args)}` : cmd);
      if (cmd !== "pt_status") return undefined;
      return {
        samples: 64,
        fault: null,
        denoised: false,
        denoising: false,
        denoiseError: null,
        ...((list.length > 1 ? list.shift() : list[0]) ?? {}),
      };
    };
    async function settle(t: NativeTracer) {
      let rounds = 0;
      while (t.present() && rounds++ < 20) await flush();
      return rounds;
    }

    it("waits for the native denoise, then pulls its frame past the raw prefetch", async () => {
      const link = new FakeLink();
      const calls: string[] = [];
      const { t, uploads } = setup(
        link,
        1,
        statuses([{ denoising: true }, { denoising: true }, { denoised: true }], calls),
      );
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
    const logged =
      (link: FakeLink, status: object = {}) =>
      async (cmd: string, args?: unknown) => {
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
      const sent = link.log.findIndex((l) => l.startsWith('pt_bloom {"bloom":{'));
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

describe("the camera a native frame was traced with", () => {
  it("is the one the tracer took before it drew the frame on screen", async () => {
    const link = new FakeLink();
    // The fake draws a frame as it is asked for, so a camera is taken after every frame asked so far.
    const { t } = setup(link, 1, async (cmd) => (cmd === "pt_camera" ? link.seq : undefined));
    await t.init();
    const at = (x: number) => {
      const c = new THREE.PerspectiveCamera();
      c.position.set(x, 0, 0);
      c.updateMatrixWorld();
      return c;
    };
    expect(t.shownView()).toBeNull();
    t.updateCamera(at(1), null);
    await t.scene.idle();
    await t.renderSample(0);
    expect(t.shownView()?.matrices[12]).toBe(1);
    // Frame 2 was asked for while frame 1 uploaded, before the camera moved.
    t.updateCamera(at(2), null);
    await t.scene.idle();
    await t.renderSample(0);
    expect(t.shownView()?.matrices[12]).toBe(1);
    await t.renderSample(0);
    expect(t.shownView()?.matrices[12]).toBe(2);
  });
});

/** A native side like the app's: a frame holds the tracer for `frameMs`, and
 *  pt_camera waits for it unless `cameraWaits` is off. Calls cost 1 ms each way. */
function slowNative(frameMs: number, cameraWaits = true) {
  let locked = false;
  const waiters: (() => void)[] = [];
  const lock = async () => {
    while (locked) await new Promise<void>((r) => waiters.push(r));
    locked = true;
  };
  const unlock = () => {
    locked = false;
    waiters.shift()?.();
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let camera = 0;
  let drawn = 0;
  let seq = 0;
  const cameraOf = new Map<number, number>();
  const link: FrameLink = {
    kind: "fake",
    async next(): Promise<NativeFrame> {
      await wait(1);
      const s = ++seq;
      await lock();
      drawn = s;
      cameraOf.set(s, camera);
      await wait(frameMs);
      unlock();
      await wait(1);
      return { seq: s, generation: 1, width: 1, height: 1, pixels: new Uint8Array(4), release() {} };
    },
    async resize() {
      return 1;
    },
    close() {},
  };
  let cameraCalls = 0;
  const call = async (cmd: string, args?: unknown) => {
    await wait(1);
    if (cmd !== "pt_camera") return cmd === "pt_status" ? { samples: 1, fault: null } : undefined;
    cameraCalls++;
    if (cameraWaits) await lock();
    camera = orbitIndex((args as { camera: { eye: number[] } }).camera.eye[0]!);
    const d = drawn;
    if (cameraWaits) unlock();
    await wait(1);
    return d;
  };
  const shown: number[] = [];
  const blit: Blit = { maxTextureSize: 4096, upload: (f) => shown.push(f.seq), dispose() {} };
  const canvas = { style: {} as Record<string, string>, remove() {} } as unknown as HTMLCanvasElement;
  const t = new NativeTracer({
    canvas,
    blit: () => blit,
    connect: async () => ({ link, generation: 1, source: "slow" }),
    call,
  });
  return { t, shown, cameraOf, cameraCalls: () => cameraCalls };
}

const orbitEye = (i: number) => 3.25 + 0.5 * i;
const orbitIndex = (x: number) => Math.round((x - 3.25) / 0.5);
function orbitCamera(i: number) {
  const c = new THREE.PerspectiveCamera(50, 1.6, 0.1, 500);
  c.position.set(orbitEye(i), -40 + 0.3 * i, 25 - 0.1 * i);
  c.lookAt(1.5, -2, 0.75);
  c.updateMatrixWorld();
  return c;
}

/** One updateCamera per tick for 2 s, a frame asked for whenever none is,
 *  then 2 s at rest. */
async function orbit(frameMs: number, hz: number, cameraWaits = true) {
  vi.useFakeTimers();
  const tickMs = 1000 / hz;
  const n = slowNative(frameMs, cameraWaits);
  const init = n.t.init();
  await vi.advanceTimersByTimeAsync(5);
  await init;
  const sentAt: number[] = [];
  const ticks: { now: number; traced: number | null; overlay: number | null }[] = [];
  let inFlight = false;
  let now = 0;
  let live = 0;
  const moving = Math.round(2000 / tickMs);
  for (let k = 0; k < 2 * moving; k++) {
    if (k < moving) {
      live = k + 1;
      sentAt[live] = now;
      n.t.updateCamera(orbitCamera(live), null);
    }
    if (!inFlight) {
      inFlight = true;
      void n.t.renderSample(0).then(() => (inFlight = false));
    }
    await vi.advanceTimersByTimeAsync(tickMs);
    now += tickMs;
    const seq = n.shown.at(-1);
    const v = n.t.shownView();
    ticks.push({
      now,
      traced: seq === undefined ? null : n.cameraOf.get(seq)!,
      overlay: v ? orbitIndex(v.matrices[12]!) : null,
    });
  }
  vi.useRealTimers();
  const drawing = ticks.filter((r) => r.traced !== null && r.traced > 0);
  const age = drawing.filter((r) => r.now <= 2000).map((r) => r.now - sentAt[r.traced!]!);
  const landed = ticks.find((r) => r.now > 2000 && r.traced === live);
  return {
    oldest: Math.max(...age),
    landedAfterStop: landed ? landed.now - 2000 : Infinity,
    offTrace: drawing.filter((r) => r.overlay !== r.traced).length,
    drawing: drawing.length,
    cameraCalls: n.cameraCalls(),
    moving,
  };
}

describe("a native tracer slower than the page's camera", () => {
  // Measured in the app before the fix: 360 to 790 ms behind at p50 and over a second after a 2 s orbit.
  for (const [frameMs, hz] of [
    [20, 144],
    [35, 60],
    [8, 60],
  ] as const) {
    it(`traces the camera at most three frames late at ${frameMs} ms a frame and ${hz} Hz, with the edges on the trace`, async () => {
      const r = await orbit(frameMs, hz);
      const frame = frameMs + 2;
      expect(r.drawing).toBeGreaterThan(50);
      expect(r.oldest).toBeLessThanOrEqual(3 * frame + 1000 / hz);
      expect(r.landedAfterStop).toBeLessThanOrEqual(2 * frame + 1000 / hz);
      expect(r.offTrace).toBe(0);
    });
  }

  it("sends fewer cameras than the page makes when the native side is slow", async () => {
    const r = await orbit(20, 144);
    expect(r.cameraCalls).toBeLessThan(r.moving / 2);
  });

  it("takes the camera at the next frame when pt_camera does not wait for the frame in progress", async () => {
    const r = await orbit(20, 144, false);
    expect(r.oldest).toBeLessThanOrEqual(2 * 22 + 1000 / 144);
    expect(r.landedAfterStop).toBeLessThanOrEqual(2 * 22 + 1000 / 144);
    expect(r.offTrace).toBe(0);
  });
});
