// Toasts with no time stay, and a full stack gives up a plain toast before one carrying a button.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useToastStore } from "../../src/stores/toasts";

(globalThis as Record<string, unknown>).window ??= globalThis;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const act = { label: "Undo", onClick: () => {} };
const showing = () =>
  useToastStore()
    .items.filter((t) => !t.leaving)
    .map((t) => t.message);

describe("toast with no time", () => {
  it("is still there after 10 minutes and goes when dismissed", () => {
    const st = useToastStore();
    const id = st.push("Deleted Extrude 4", "info", act, null);
    vi.advanceTimersByTime(600000);
    expect(showing()).toEqual(["Deleted Extrude 4"]);
    st.dismiss(id);
    vi.advanceTimersByTime(200);
    expect(showing()).toEqual([]);
  });

  it("a repeat of it with a time starts that timer", () => {
    const st = useToastStore();
    st.push("Copied 3 edges", "info", undefined, null);
    st.push("Copied 3 edges", "info", undefined, 5000);
    vi.advanceTimersByTime(4990);
    expect(showing()).toEqual(["Copied 3 edges"]);
    vi.advanceTimersByTime(20);
    expect(showing()).toEqual([]);
  });

  it("survives a pause and resume", () => {
    const st = useToastStore();
    st.push("Pasted 7 faces", "warning", undefined, null);
    st.pause();
    st.resume();
    vi.advanceTimersByTime(600000);
    expect(showing()).toEqual(["Pasted 7 faces"]);
  });
});

describe("eviction", () => {
  it("evicts the plain toast between two with buttons", () => {
    const st = useToastStore();
    st.push("A 1", "info", act, 15000);
    st.push("B 2", "info", undefined, 5000);
    st.push("C 3", "info", act, 15000);
    st.push("D 4", "info", undefined, 5000);
    expect(st.items.map((t) => t.message)).toEqual(["A 1", "C 3", "D 4"]);
  });

  it("evicts the oldest plain one when several are plain", () => {
    const st = useToastStore();
    st.push("A 1", "info", undefined, 5000);
    st.push("B 2", "info", act, 15000);
    st.push("C 3", "info", undefined, 5000);
    st.push("D 4", "info", undefined, 5000);
    expect(st.items.map((t) => t.message)).toEqual(["B 2", "C 3", "D 4"]);
  });

  it("evicts the oldest when all three have a button", () => {
    const st = useToastStore();
    st.push("A 1", "info", act, 15000);
    st.push("B 2", "info", { ...act, label: "Show" }, 15000);
    st.push("C 3", "info", { ...act, label: "Fix" }, 15000);
    st.push("D 4", "info", act, 15000);
    expect(st.items.map((t) => t.message)).toEqual(["B 2", "C 3", "D 4"]);
  });

  it("evicts nothing with 0, 1 or 2 rows, and an evicted toast's timer does not remove a later one", () => {
    const st = useToastStore();
    st.push("A 1", "info", undefined, 5000);
    st.push("B 2", "info", undefined, 5000);
    expect(st.items).toHaveLength(2);
    st.push("C 3", "info", undefined, 5000);
    st.push("D 4", "info", act, 15000);
    expect(st.items.map((t) => t.message)).toEqual(["B 2", "C 3", "D 4"]);
    vi.advanceTimersByTime(5010);
    expect(showing()).toEqual(["D 4"]);
  });

  it("takes a toast already leaving before a showing plain one", () => {
    const st = useToastStore();
    const a = st.push("A 1", "info", act, 15000);
    st.push("B 2", "info", undefined, 5000);
    st.push("C 3", "info", act, 15000);
    st.dismiss(a);
    st.push("D 4", "info", undefined, 5000);
    expect(st.items.map((t) => t.message)).toEqual(["B 2", "C 3", "D 4"]);
  });
});
