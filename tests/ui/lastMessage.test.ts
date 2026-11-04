// Show Last Message reads toast.ts's own record: it says the newest message again and shows it again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const announce = vi.hoisted(() => vi.fn());
vi.mock("../../src/ui/announce", () => ({ announce }));

// The toast store times its rows with window.setTimeout, which must follow the fake timers.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = {
    setTimeout: (...a: Parameters<typeof setTimeout>) => globalThis.setTimeout(...a),
    clearTimeout: (id: number) => globalThis.clearTimeout(id),
    addEventListener: () => {},
  };
});

type Toast = typeof import("../../src/ui/toast");
let t: Toast;
let rows: () => { message: string; kind: string; action: { label: string } | undefined }[];
let store: ReturnType<typeof import("../../src/stores/toasts").useToastStore>;

// A fresh module copy per test, so the record starts empty.
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  announce.mockClear();
  const { createPinia, setActivePinia } = await import("pinia");
  setActivePinia(createPinia());
  t = await import("../../src/ui/toast");
  store = (await import("../../src/stores/toasts")).useToastStore();
  rows = () =>
    store.items.filter((x) => !x.leaving).map((x) => ({ message: x.message, kind: x.kind, action: x.action }));
});
afterEach(() => vi.useRealTimers());

describe("Show Last Message", () => {
  it("with no message says and shows No messages yet, without recording it", () => {
    t.showLastMessage();
    expect(announce.mock.calls).toEqual([["No messages yet", "polite"]]);
    expect(rows()).toEqual([{ message: "No messages yet", kind: "info", action: undefined }]);
    vi.advanceTimersByTime(60000);
    expect(rows()).toEqual([]);
    announce.mockClear();
    t.showLastMessage();
    expect(announce.mock.calls).toEqual([["No messages yet", "polite"]]);
  });

  it("after an info then a warning, says the warning assertive and shows it again", () => {
    t.toast("Saved 3 parts to plate 7.funda");
    t.toast("Sketch 4 has a 2.5 mm gap", { kind: "warning" });
    vi.advanceTimersByTime(60000);
    announce.mockClear();
    t.showLastMessage();
    expect(announce.mock.calls).toEqual([["Sketch 4 has a 2.5 mm gap", "assertive"]]);
    expect(rows()).toEqual([{ message: "Sketch 4 has a 2.5 mm gap", kind: "warning", action: undefined }]);
  });

  it("while the original still shows its time starts over and no second row appears", () => {
    t.toast("Deleted Extrude 4", { action: { label: "Undo", onClick: () => {} } });
    vi.advanceTimersByTime(14000);
    t.showLastMessage();
    expect(rows().map((r) => [r.message, r.action?.label])).toEqual([["Deleted Extrude 4", "Undo"]]);
    vi.advanceTimersByTime(14000);
    expect(rows()).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    expect(rows()).toEqual([]);
  });

  it("after the original left, a copy without its button appears", () => {
    t.toast("Deleted Extrude 4", { action: { label: "Undo", onClick: () => {} } });
    vi.advanceTimersByTime(20000);
    expect(rows()).toEqual([]);
    announce.mockClear();
    t.showLastMessage();
    expect(rows()).toEqual([{ message: "Deleted Extrude 4", kind: "info", action: undefined }]);
    expect(announce.mock.calls).toEqual([["Deleted Extrude 4", "polite"]]);
  });

  it("an error is said again assertive and shown in the stack as an error", () => {
    t.toast("Fillet 2 failed on edge 7", { kind: "error" });
    expect(rows()).toEqual([]);
    announce.mockClear();
    t.showLastMessage();
    expect(announce.mock.calls).toEqual([["Fillet 2 failed on edge 7", "assertive"]]);
    expect(rows()).toEqual([{ message: "Fillet 2 failed on edge 7", kind: "error", action: undefined }]);
  });

  it("calling it twice repeats the same message, its own output is never the newest", () => {
    t.toast("Pasted 4 faces");
    t.toast("Moved 2 bodies by 12.5 mm");
    vi.advanceTimersByTime(60000);
    t.showLastMessage();
    vi.advanceTimersByTime(60000);
    announce.mockClear();
    t.showLastMessage();
    expect(announce.mock.calls).toEqual([["Moved 2 bodies by 12.5 mm", "polite"]]);
    expect(rows().map((r) => r.message)).toEqual(["Moved 2 bodies by 12.5 mm"]);
  });

  it("restarts only the newest toast when two show", () => {
    t.toast("Pasted 4 faces");
    vi.advanceTimersByTime(4000);
    t.toast("Moved 2 bodies by 12.5 mm");
    vi.advanceTimersByTime(900);
    t.showLastMessage();
    vi.advanceTimersByTime(300);
    expect(rows().map((r) => r.message)).toEqual(["Moved 2 bodies by 12.5 mm"]);
    vi.advanceTimersByTime(4800);
    expect(rows().map((r) => r.message)).toEqual([]);
  });
});
