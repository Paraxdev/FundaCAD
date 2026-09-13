import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClickOrDouble, DOUBLE_CLICK_MS, HistoryPeek } from "../../src/ui/historyPeek";

/** A rollback marker over `n` features, recording every write. */
function marker(n: number, at = n) {
  const state = { n, at, writes: [] as number[] };
  let peek: HistoryPeek;
  const access = {
    get: () => state.at,
    set: (i: number) => { state.at = Math.min(i, state.n); state.writes.push(i); peek?.observe(state.at); },
    length: () => state.n,
  };
  peek = new HistoryPeek(access);
  return { state, peek, moveByHand: (i: number) => { state.at = i; peek.observe(i); } };
}

describe("HistoryPeek", () => {
  it("rolls to a step and Escape returns to the tip it started from", () => {
    const { state, peek } = marker(10);
    peek.peek(3);
    expect(state.at).toBe(4);
    expect(peek.active).toBe(true);
    expect(peek.release()).toBe(true);
    expect(state.at).toBe(10);
    expect(peek.active).toBe(false);
  });

  it("returns to a rolled back marker, not the end", () => {
    const { state, peek } = marker(10, 6);
    peek.peek(1);
    peek.peek(8); // peeking around keeps the ORIGINAL position
    expect(state.at).toBe(9);
    peek.release();
    expect(state.at).toBe(6);
  });

  it("releases on a second double-click of the same step", () => {
    const { state, peek } = marker(10, 7);
    peek.peek(2);
    peek.peek(2);
    expect(state.at).toBe(7);
    expect(peek.active).toBe(false);
  });

  it("returns to the tip even when the tip moved during the peek", () => {
    const { state, peek } = marker(10);
    peek.peek(2);
    state.n = 11; // a feature was added while peeking
    peek.release();
    expect(state.at).toBe(11);
  });

  it("forgets the peek once the marker is moved by hand, so Escape does not undo that", () => {
    const { state, peek, moveByHand } = marker(10);
    peek.peek(2);
    moveByHand(5);
    expect(peek.active).toBe(false);
    expect(peek.release()).toBe(false);
    expect(state.at).toBe(5);
  });

  it("leaves Escape alone when nothing is being peeked", () => {
    const { state, peek } = marker(10, 4);
    expect(peek.release()).toBe(false);
    expect(state.writes).toEqual([]);
  });
});

describe("ClickOrDouble", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function rig() {
    const log: string[] = [];
    const c = new ClickOrDouble<string>((k) => log.push(`edit ${k}`), (k) => log.push(`peek ${k}`));
    return { log, c };
  }

  it("runs a single click once the double-click window passes", () => {
    const { log, c } = rig();
    c.click("a", 1);
    expect(log).toEqual([]);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(log).toEqual(["edit a"]);
  });

  it("never edits on the first half of a double-click", () => {
    const { log, c } = rig();
    c.click("a", 1);
    c.click("a", 2);
    c.dblclick("a");
    vi.advanceTimersByTime(DOUBLE_CLICK_MS * 3);
    expect(log).toEqual(["peek a"]);
  });

  it("acts at once on a keyboard click, which has no double to wait for", () => {
    const { log, c } = rig();
    c.click("a", 0);
    expect(log).toEqual(["edit a"]);
  });

  it("a click on another step replaces a pending one", () => {
    const { log, c } = rig();
    c.click("a", 1);
    c.click("b", 1);
    vi.advanceTimersByTime(DOUBLE_CLICK_MS);
    expect(log).toEqual(["edit b"]);
  });
});
