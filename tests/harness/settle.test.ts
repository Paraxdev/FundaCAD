import { describe, expect, it } from "vitest";
import { settle, type Clock, type SettleHost } from "../../src/harness/settle";
import { HarnessError } from "../../src/harness/locate";

function rig() {
  let t = 0;
  let frames: (() => void)[] = [];
  const clock: Clock = { now: () => t, frame: (cb) => { frames.push(cb); } };
  const state = { pending: false, building: false, busy: false, inFlight: 0, idle: true, open: true, trace: "idle", samples: 0 };
  const buildFns: (() => void)[] = [];
  const h = {
    store: {
      get buildState() { return { building: state.building }; },
      get busyState() { return { active: state.busy, label: "Importing", pct: 40 }; },
      get rebuildPending() { return state.pending; },
      onBuild: (fn: () => void) => { buildFns.push(fn); return () => {}; },
      onDocChange: () => () => {},
    },
    geometry: { get connected() { return state.open; }, get inFlight() { return state.inFlight; } },
    viewport: {
      get renderIdle() { return state.idle; },
      get traceStatus() { return { state: state.trace, samples: state.samples }; },
    },
  } as unknown as SettleHost;

  /** Runs frames 16 ms apart, `each` changes the app before frame n. */
  async function run(args: Parameters<typeof settle>[1], each?: (n: number) => void, maxFrames = 400) {
    const p = settle(h, args, clock);
    let done = false;
    p.then(() => { done = true; }, () => { done = true; });
    for (let n = 0; n < maxFrames && !done; n++) {
      t += 16;
      each?.(n);
      const f = frames;
      frames = [];
      f.forEach((cb) => cb());
      await Promise.resolve();
    }
    return p;
  }
  return { state, run, emitBuild: () => buildFns.forEach((f) => f()) };
}

describe("settle", () => {
  it("waits out the quiet window on an idle app", async () => {
    const { ms } = await rig().run({});
    expect(ms).toBeGreaterThanOrEqual(150);
    expect(ms).toBeLessThan(250);
  });

  for (const [what, set] of [
    ["a pending rebuild", (s: ReturnType<typeof rig>["state"]) => { s.pending = true; }],
    ["a running build", (s: ReturnType<typeof rig>["state"]) => { s.building = true; }],
    ["a long operation", (s: ReturnType<typeof rig>["state"]) => { s.busy = true; }],
    ["a request in flight", (s: ReturnType<typeof rig>["state"]) => { s.inFlight = 1; }],
    ["a moving camera", (s: ReturnType<typeof rig>["state"]) => { s.idle = false; }],
  ] as const) {
    it(`holds for ${what}`, async () => {
      const r = rig();
      set(r.state);
      const { ms } = await r.run({}, (n) => { if (n === 30) Object.assign(r.state, { pending: false, building: false, busy: false, inFlight: 0, idle: true }); });
      expect(ms).toBeGreaterThanOrEqual(30 * 16 + 3 * 16);
    });
  }

  it("starts the quiet window again after a build event", async () => {
    const r = rig();
    const { ms } = await r.run({}, (n) => { if (n === 8) r.emitBuild(); });
    expect(ms).toBeGreaterThanOrEqual(9 * 16 + 150);
  });

  it("waits for the path tracer when asked", async () => {
    const r = rig();
    r.state.trace = "running";
    const { ms } = await r.run({ trace: 8 }, (n) => { if (n === 20) Object.assign(r.state, { trace: "done", samples: 8 }); });
    expect(ms).toBeGreaterThanOrEqual(20 * 16);
  });

  it("gives up with one line on what is still going on", async () => {
    const r = rig();
    Object.assign(r.state, { building: true, busy: true, inFlight: 2 });
    const err = await r.run({ timeoutMs: 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).kind).toBe("SettleTimeout");
    expect((err as Error).message).toBe('not settled after 1 s: building, busy "Importing" 40%, 2 requests in flight, socket open');
  });
});
