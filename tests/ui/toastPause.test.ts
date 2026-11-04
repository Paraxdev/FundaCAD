import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useToastStore } from "../../src/stores/toasts";

(globalThis as Record<string, unknown>).window ??= globalThis;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const showing = () =>
  useToastStore()
    .items.filter((t) => !t.leaving)
    .map((t) => t.message);

describe("toast pause and resume", () => {
  it("waits while paused and goes a full hold after resume, not before", () => {
    const st = useToastStore();
    st.push("Saved 3 parts", "info", undefined, 8000);
    vi.advanceTimersByTime(7900);
    st.pause();
    vi.advanceTimersByTime(20000);
    expect(showing()).toEqual(["Saved 3 parts"]);
    st.resume();
    vi.advanceTimersByTime(7990);
    expect(showing()).toEqual(["Saved 3 parts"]);
    vi.advanceTimersByTime(20);
    expect(showing()).toEqual([]);
  });

  it("leaves on time when never paused, at the exact boundary", () => {
    const st = useToastStore();
    st.push("Copied 2 edges", "info", undefined, 3500);
    vi.advanceTimersByTime(3499);
    expect(showing()).toEqual(["Copied 2 edges"]);
    vi.advanceTimersByTime(2);
    expect(showing()).toEqual([]);
  });

  it("a toast pushed while paused waits, then gets its own full hold", () => {
    const st = useToastStore();
    st.pause();
    st.push("Pasted 4 faces", "warning", undefined, 6000);
    vi.advanceTimersByTime(60000);
    expect(showing()).toEqual(["Pasted 4 faces"]);
    st.resume();
    vi.advanceTimersByTime(5990);
    expect(showing()).toEqual(["Pasted 4 faces"]);
    vi.advanceTimersByTime(20);
    expect(showing()).toEqual([]);
  });

  it("a duplicate while paused starts no timer", () => {
    const st = useToastStore();
    st.push("Filleted 7 edges", "info", undefined, 4000);
    st.pause();
    st.push("Filleted 7 edges", "info", undefined, 4000);
    expect(st.items).toHaveLength(1);
    vi.advanceTimersByTime(30000);
    expect(showing()).toEqual(["Filleted 7 edges"]);
    st.resume();
    vi.advanceTimersByTime(4020);
    expect(showing()).toEqual([]);
  });

  it("two toasts with different holds each restart their own on resume", () => {
    const st = useToastStore();
    st.push("Short one", "info", undefined, 3500);
    st.push("Long one", "info", undefined, 12000);
    vi.advanceTimersByTime(3000);
    st.pause();
    vi.advanceTimersByTime(50000);
    st.resume();
    vi.advanceTimersByTime(3510);
    expect(showing()).toEqual(["Long one"]);
    vi.advanceTimersByTime(8500);
    expect(showing()).toEqual([]);
  });

  it("a second pause and resume works and a dismissed toast stays gone", () => {
    const st = useToastStore();
    st.push("Gone", "info", undefined, 1000);
    st.push("Stays", "info", undefined, 9000);
    st.dismiss(st.items[0]!.id);
    st.pause();
    st.resume();
    st.pause();
    vi.advanceTimersByTime(30000);
    expect(showing()).toEqual(["Stays"]);
    st.resume();
    vi.advanceTimersByTime(9010);
    expect(showing()).toEqual([]);
  });
});

describe("toast hold under a modal", () => {
  const undo = { label: "Undo", onClick: () => {} };

  it("holds only a toast with a button, which gets a full hold after the modal closes", () => {
    const st = useToastStore();
    st.push("Deleted Box 2", "info", undo, 15000);
    st.push("Saved 3 parts", "info", undefined, 5000);
    vi.advanceTimersByTime(1000);
    st.pause("modal");
    vi.advanceTimersByTime(60000);
    expect(showing()).toEqual(["Deleted Box 2"]);
    st.resume("modal");
    vi.advanceTimersByTime(14990);
    expect(showing()).toEqual(["Deleted Box 2"]);
    vi.advanceTimersByTime(20);
    expect(showing()).toEqual([]);
  });

  it("a toast with a button raised inside the modal waits until it closes", () => {
    const st = useToastStore();
    st.pause("modal");
    st.push("Restored the defaults", "info", undo, 15000);
    vi.advanceTimersByTime(60000);
    expect(showing()).toEqual(["Restored the defaults"]);
    st.resume("modal");
    vi.advanceTimersByTime(15010);
    expect(showing()).toEqual([]);
  });

  it("the stack hold and the modal hold each keep their toasts until their own resume", () => {
    const st = useToastStore();
    st.push("Deleted Box 2", "info", undo, 15000);
    st.push("Saved 3 parts", "info", undefined, 5000);
    st.pause();
    st.pause("modal");
    st.resume();
    vi.advanceTimersByTime(60000);
    expect(showing()).toEqual(["Deleted Box 2"]);
    st.pause();
    st.resume("modal");
    vi.advanceTimersByTime(60000);
    expect(showing()).toEqual(["Deleted Box 2"]);
    st.resume();
    vi.advanceTimersByTime(15010);
    expect(showing()).toEqual([]);
  });

  it("a modal resume with no modal hold restarts nothing", () => {
    const st = useToastStore();
    st.push("Deleted Box 2", "info", undo, 15000);
    vi.advanceTimersByTime(10000);
    st.resume("modal");
    vi.advanceTimersByTime(5010);
    expect(showing()).toEqual([]);
  });
});
