import { describe, expect, it } from "vitest";
import { HeldSignal } from "../../src/features/heldEdit";

describe("HeldSignal", () => {
  it("tells its watchers when the held state turns on and off", () => {
    const signal = new HeldSignal();
    const seen: string[] = [];
    signal.on(() => seen.push("changed"));
    signal.sync(true);
    signal.sync(false);
    expect(seen).toEqual(["changed", "changed"]);
  });

  it("stays quiet while the held state does not change, and after a watcher leaves", () => {
    const signal = new HeldSignal();
    const seen: string[] = [];
    const off = signal.on(() => seen.push("changed"));
    signal.sync(false);
    signal.sync(true);
    signal.sync(true);
    off();
    signal.sync(false);
    expect(seen).toEqual(["changed"]);
  });
});
