// A toast with an action (Tie Loose Ends, Close gap) stacked a copy each time
// the same command ran, and left after 3.5 s, before most people had read it
// and moved the pointer to its button.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useToastStore } from "../../src/stores/toasts";
import { toast } from "../../src/ui/toast";

// the toast store times its rows with window.setTimeout
(globalThis as Record<string, unknown>).window ??= globalThis;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("toasts that carry an action", () => {
  it("the same message and action shown twice is one row, running the newer action", () => {
    const first = vi.fn(),
      second = vi.fn();
    toast("That sketch has a 3 mm gap", { action: { label: "Close gap", onClick: first } });
    toast("That sketch has a 3 mm gap", { action: { label: "Close gap", onClick: second } });
    const st = useToastStore();
    expect(st.items).toHaveLength(1);
    st.items[0]!.action!.onClick();
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("stays long enough to read and reach its button", () => {
    toast("That sketch has a 3 mm gap", { action: { label: "Close gap", onClick: () => {} } });
    vi.advanceTimersByTime(7500);
    expect(useToastStore().items.filter((t) => !t.leaving)).toHaveLength(1);
  });

  it("a plain info toast keeps its short life", () => {
    toast("Copied.");
    vi.advanceTimersByTime(3600);
    expect(useToastStore().items.filter((t) => !t.leaving)).toHaveLength(0);
  });
});
