// A toast with an action (Tie Loose Ends, Close gap) stacked a copy each time
// the same command ran, and left after 3.5 s, before most people had read it
// and moved the pointer to its button. A hint shows once while its words are up.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useToastStore } from "../../src/stores/toasts";
import { dismissToastsSaying, hintToast, toast } from "../../src/ui/toast";
import { noticeHoldMs } from "../../src/ui/noticeTime";

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
    vi.advanceTimersByTime(14990);
    expect(useToastStore().items.filter((t) => !t.leaving)).toHaveLength(1);
    vi.advanceTimersByTime(20);
    expect(useToastStore().items.filter((t) => !t.leaving)).toHaveLength(0);
  });

  it("a plain info toast keeps its short life", () => {
    toast("Copied.");
    vi.advanceTimersByTime(4990);
    expect(useToastStore().items.filter((t) => !t.leaving)).toHaveLength(1);
    vi.advanceTimersByTime(20);
    expect(useToastStore().items.filter((t) => !t.leaving)).toHaveLength(0);
  });
});

describe("a hint", () => {
  const showing = () =>
    useToastStore()
      .items.filter((t) => !t.leaving)
      .map((t) => t.message);

  it("is not shown again while the same words are up, and is once they have gone", () => {
    hintToast("Pick a flat face");
    vi.advanceTimersByTime(noticeHoldMs("info", false)! - 100);
    hintToast("Pick a flat face");
    hintToast("Finish the active tool first");
    expect(showing()).toEqual(["Pick a flat face", "Finish the active tool first"]);
    vi.advanceTimersByTime(150);
    expect(showing()).toEqual(["Finish the active tool first"]);
    hintToast("Pick a flat face");
    expect(showing()).toEqual(["Finish the active tool first", "Pick a flat face"]);
  });

  it("taken down by its words leaves the others, and shows again at once", () => {
    toast("Copied.");
    hintToast("Pick a flat face");
    hintToast("Finish the active tool first");
    dismissToastsSaying("Pick a flat face");
    expect(showing()).toEqual(["Copied.", "Finish the active tool first"]);
    vi.advanceTimersByTime(200);
    hintToast("Pick a flat face");
    expect(showing()).toEqual(["Copied.", "Finish the active tool first", "Pick a flat face"]);
  });
});
