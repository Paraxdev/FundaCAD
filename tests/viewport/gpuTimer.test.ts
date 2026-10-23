import { describe, expect, it } from "vitest";
import { GpuTimer } from "../../src/viewport/gpuTimer";

const TIME_ELAPSED = 0x88bf;
const DISJOINT = 0x8fbb;

function fakeGl(withExt = true) {
  const live = new Map<object, { ns: number | null }>();
  const log: string[] = [];
  let open: object | null = null;
  let disjoint = false;
  let signaled = false;
  const gl = {
    QUERY_RESULT_AVAILABLE: 1,
    QUERY_RESULT: 2,
    SYNC_GPU_COMMANDS_COMPLETE: 3,
    SYNC_STATUS: 4,
    SIGNALED: 5,
    getExtension: (n: string) =>
      withExt && n === "EXT_disjoint_timer_query_webgl2"
        ? { TIME_ELAPSED_EXT: TIME_ELAPSED, GPU_DISJOINT_EXT: DISJOINT }
        : null,
    createQuery: () => {
      const q = {};
      live.set(q, { ns: null });
      return q;
    },
    beginQuery: (t: number, q: object) => {
      if (open) throw new Error("a query is already active");
      expect(t).toBe(TIME_ELAPSED);
      open = q;
      log.push("begin");
    },
    endQuery: () => {
      if (!open) throw new Error("no active query");
      open = null;
      log.push("end");
    },
    deleteQuery: (q: object) => {
      live.delete(q);
    },
    getQueryParameter: (q: object, p: number) => {
      const s = live.get(q)!;
      return p === 1 ? s.ns !== null : s.ns;
    },
    getParameter: (p: number) => (p === DISJOINT ? disjoint : null),
    isContextLost: () => false,
    fenceSync: () => ({}),
    deleteSync: () => {},
    getSyncParameter: () => (signaled ? 5 : 0),
  };
  /** Finish the ended queries that are still unread, oldest first, with these durations in ms. */
  const finish = (...ms: number[]) => {
    const ready = [...live].filter(([q, s]) => s.ns === null && q !== open);
    ready.forEach(([, s], i) => {
      s.ns = (ms[i] ?? 0) * 1e6;
    });
  };
  return {
    gl: gl as unknown as WebGL2RenderingContext,
    live,
    log,
    finish,
    setDisjoint: (v: boolean) => {
      disjoint = v;
    },
    signal: (v: boolean) => {
      signaled = v;
    },
  };
}

function frameOf(t: GpuTimer, f: ReturnType<typeof fakeGl>, passes: [string, number][]) {
  t.frame();
  for (const [name] of passes) {
    t.begin(name);
    t.end(name);
  }
  f.finish(...passes.map(([, ms]) => ms));
}

describe("GpuTimer with the timer query extension", () => {
  it("reads a result back on a later frame and frees the query", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    expect(t.kind).toBe("timer-query");
    frameOf(t, f, [["main", 4]]);
    expect(t.medians()).toEqual({});
    t.frame();
    expect(t.medians()).toEqual({ main: 4 });
    expect(f.live.size).toBe(0);
  });

  it("waits while the result is not available yet", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.frame();
    t.begin("main");
    t.end("main");
    t.frame();
    expect(t.medians()).toEqual({});
    f.finish(3);
    t.frame();
    expect(t.medians()).toEqual({ main: 3 });
  });

  it("reports a pass without its children when passes nest", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.frame();
    t.begin("main");
    t.begin("shadow");
    t.end("shadow");
    t.end("main");
    f.finish(2, 5, 1);
    t.frame();
    expect(t.medians()).toEqual({ main: 3, shadow: 5 });
    expect(f.log.join()).toBe("begin,end,begin,end,begin,end");
  });

  it("takes the median over the last frames", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl, undefined, 3);
    for (const ms of [1, 9, 5, 6, 100]) frameOf(t, f, [["main", ms]]);
    t.frame();
    expect(t.medians().main).toBe(6);
  });

  it("drops the frames in flight when the GPU reports a disjoint event", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    frameOf(t, f, [["main", 50]]);
    f.setDisjoint(true);
    t.frame();
    f.setDisjoint(false);
    expect(f.live.size).toBe(0);
    frameOf(t, f, [["main", 2]]);
    t.frame();
    expect(t.medians()).toEqual({ main: 2 });
  });

  it("ignores an end that does not match the pass in progress", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.frame();
    t.begin("main");
    t.end("shadow");
    expect(f.log).toEqual(["begin"]);
  });

  it("throws a segment away when told the pass drew nothing", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    t.frame();
    t.begin("shadow");
    t.end("shadow", false);
    expect(f.live.size).toBe(0);
    t.frame();
    expect(t.medians()).toEqual({});
  });

  it("keeps only a bounded number of unread queries", () => {
    const f = fakeGl();
    const t = new GpuTimer(f.gl);
    for (let i = 0; i < 500; i++) {
      t.frame();
      t.begin("main");
      t.end("main");
    }
    expect(f.live.size).toBeLessThanOrEqual(64);
  });
});

describe("GpuTimer without the extension", () => {
  it("falls back to the period of the whole frame from a fence", () => {
    const f = fakeGl(false);
    let clock = 0;
    const t = new GpuTimer(f.gl, () => clock);
    expect(t.kind).toBe("fence");
    t.frame();
    t.begin("main");
    t.end("main");
    clock = 10;
    t.endFrame();
    clock = 18;
    t.frame();
    expect(t.medians()).toEqual({});
    f.signal(true);
    clock = 22;
    t.frame();
    expect(t.medians()).toEqual({ frame: 12 });
  });

  it("does nothing without a context", () => {
    const t = new GpuTimer(null);
    expect(t.kind).toBe("none");
    t.frame();
    t.begin("main");
    t.end("main");
    t.endFrame();
    expect(t.medians()).toEqual({});
  });
});
