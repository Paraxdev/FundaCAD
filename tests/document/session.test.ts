import { describe, expect, it, vi } from "vitest";
import { DocumentSession, SessionEnded, SessionHost, isSessionEnded } from "../../src/document/session";

const settle = () => new Promise((r) => setTimeout(r, 0));
const outcome = <T>(p: Promise<T>) =>
  p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, ended: isSessionEnded(e), msg: (e as Error).message }),
  );

describe("DocumentSession", () => {
  it("runs disposers in reverse order of registration, once, and skips an unregistered one", () => {
    const s = new DocumentSession();
    const order: string[] = [];
    s.own(() => order.push("a"));
    const offB = s.own(() => order.push("b"));
    s.listen(() => order.push("c"));
    offB();
    s.end("new");
    s.end("open");
    expect({ order, alive: s.alive, by: s.endedBy, aborted: s.signal.aborted }).toEqual({
      order: ["c", "a"],
      alive: false,
      by: "new",
      aborted: true,
    });
  });

  it("disposes at once what is owned after it ended, and a throwing disposer does not stop the others", () => {
    const s = new DocumentSession();
    const order: string[] = [];
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    s.own(() => order.push("first"));
    s.own(() => {
      throw new Error("broken part");
    });
    s.end("discard");
    s.own(() => order.push("late"));
    expect({ order, logged: err.mock.calls.length }).toEqual({ order: ["first", "late"], logged: 1 });
    err.mockRestore();
  });

  it("step resolves while alive, rejects SessionEnded when ended before or meanwhile, passes other errors", async () => {
    const live = new DocumentSession();
    const before = new DocumentSession();
    before.end("new");
    const during = new DocumentSession();
    let release!: (v: number) => void;
    const held = during.step(new Promise<number>((r) => (release = r)));
    during.end("open");
    release(3);
    const settledThenEnded = new DocumentSession();
    const resolved = settledThenEnded.step(Promise.resolve(5));
    const results = await Promise.all([
      outcome(live.step(Promise.resolve(1))),
      outcome(live.step(Promise.reject(new Error("engine said no")))),
      outcome(before.step(Promise.resolve(2))),
      outcome(held),
      outcome(resolved),
    ]);
    settledThenEnded.end("new");
    expect(results).toEqual([
      { ok: true, v: 1 },
      { ok: false, ended: false, msg: "engine said no" },
      { ok: false, ended: true, msg: new SessionEnded().message },
      { ok: false, ended: true, msg: new SessionEnded().message },
      { ok: true, v: 5 },
    ]);
  });

  it("a promise that settles after the session ended is rejected even if it resolves", async () => {
    const s = new DocumentSession();
    let release!: (v: string) => void;
    const p = outcome(s.step(new Promise<string>((r) => (release = r))));
    await settle();
    s.end("close");
    release("late reply");
    expect(await p).toEqual({ ok: false, ended: true, msg: new SessionEnded().message });
  });

  it("timeout fires while alive, never after end, and its cancel stops it", async () => {
    vi.useFakeTimers();
    const fired: string[] = [];
    const a = new DocumentSession();
    a.timeout(() => fired.push("a"), 10);
    const b = new DocumentSession();
    b.timeout(() => fired.push("b"), 10);
    const c = new DocumentSession();
    const stop = c.timeout(() => fired.push("c"), 10);
    stop();
    b.end("new");
    const d = new DocumentSession();
    d.end("new");
    d.timeout(() => fired.push("d"), 10);
    vi.advanceTimersByTime(20);
    vi.useRealTimers();
    expect(fired).toEqual(["a"]);
  });
});

describe("SessionHost", () => {
  it("ends the current session before onBegin sees the next one", () => {
    const host = new SessionHost();
    const first = host.current;
    const seen: { prevAlive: boolean; isCurrent: boolean; reason: string | null }[] = [];
    host.onBegin((s) => seen.push({ prevAlive: first.alive, isCurrent: host.current === s, reason: first.endedBy }));
    const second = host.begin("open");
    const third = host.begin("new");
    expect({
      seen,
      alive: [first.alive, second.alive, third.alive],
      ids: new Set([first.id, second.id, third.id]).size,
      current: host.current === third,
    }).toEqual({
      seen: [
        { prevAlive: false, isCurrent: true, reason: "open" },
        { prevAlive: false, isCurrent: true, reason: "open" },
      ],
      alive: [false, false, true],
      ids: 3,
      current: true,
    });
  });

  it("a removed onBegin listener is not called", () => {
    const host = new SessionHost();
    let calls = 0;
    const off = host.onBegin(() => calls++);
    host.begin("new");
    off();
    host.begin("new");
    expect(calls).toBe(1);
  });
});
