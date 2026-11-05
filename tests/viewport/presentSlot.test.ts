import { describe, expect, it } from "vitest";
import { PresentSlot } from "../../src/viewport/pathtrace/presentSlot";

function setup() {
  const shown: number[] = [];
  const refreshes = new Map<number, () => void>();
  let id = 0;
  const slot = new PresentSlot<number>(
    (n) => shown.push(n),
    (cb) => {
      refreshes.set(++id, cb);
      return id;
    },
    (h) => refreshes.delete(h),
  );
  const refresh = () => {
    const due = [...refreshes.values()];
    refreshes.clear();
    for (const cb of due) cb();
  };
  return { slot, shown, refreshes, refresh };
}

describe("present slot", () => {
  it("shows the newest frame at the next refresh and drops the older ones", () => {
    const { slot, shown, refresh } = setup();
    slot.put(1);
    slot.put(2);
    slot.put(3);
    expect(shown).toEqual([]);
    refresh();
    expect(shown).toEqual([3]);
  });

  it("asks for one refresh per waiting frame, and none at idle", () => {
    const { slot, shown, refreshes, refresh } = setup();
    expect(refreshes.size).toBe(0);
    slot.put(1);
    slot.put(2);
    expect(refreshes.size).toBe(1);
    refresh();
    expect(refreshes.size).toBe(0);
    refresh();
    expect(shown).toEqual([2]);
  });

  it("keeps the last frame when a refresh has nothing new", () => {
    const { slot, shown, refresh } = setup();
    slot.put(1);
    refresh();
    refresh();
    refresh();
    expect(shown).toEqual([1]);
  });

  it("shows a frame at once on flush, and that refresh then has nothing to do", () => {
    const { slot, shown, refresh } = setup();
    slot.put(1);
    slot.flush();
    expect(shown).toEqual([1]);
    slot.flush();
    refresh();
    expect(shown).toEqual([1]);
  });

  it("a frame put after a flush still gets a refresh of its own", () => {
    const { slot, shown, refresh } = setup();
    slot.put(1);
    slot.flush();
    slot.put(2);
    refresh();
    expect(shown).toEqual([1, 2]);
  });

  it("shows nothing after dispose", () => {
    const { slot, shown, refreshes, refresh } = setup();
    slot.put(1);
    slot.dispose();
    expect(refreshes.size).toBe(0);
    refresh();
    slot.flush();
    slot.put(2);
    refresh();
    expect(shown).toEqual([]);
  });
});
