// Every toast is spoken once through announce(): info polite, warning assertive, errors by the title bar notice.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

const announce = vi.hoisted(() => vi.fn());
vi.mock("../../src/ui/announce", () => ({ announce }));

import { toast } from "../../src/ui/toast";
import { dismissErrorNotice } from "../../src/ui/errorNotice";

// the toast store times its rows with window.setTimeout
(globalThis as Record<string, unknown>).window ??= globalThis;

beforeEach(() => {
  setActivePinia(createPinia());
  announce.mockClear();
  dismissErrorNotice();
});

describe("toasts are spoken", () => {
  it("an info toast is polite, with no key when none is given", () => {
    toast("Saved 3 parts to plate 7.funda");
    expect(announce.mock.calls).toEqual([["Saved 3 parts to plate 7.funda", "polite", {}]]);
  });

  it("a warning toast is assertive", () => {
    toast("Sketch 4 has a 2.5 mm gap", { kind: "warning" });
    expect(announce.mock.calls).toEqual([["Sketch 4 has a 2.5 mm gap", "assertive", {}]]);
  });

  it("a button is named after the message, with where to find it", () => {
    toast("Deleted Box 2", { action: { label: "Undo", onClick: () => {} } });
    expect(announce.mock.calls).toEqual([["Deleted Box 2. Undo button in Notifications.", "polite", {}]]);
  });

  it("a message already ending a sentence gets no second full stop", () => {
    toast("Update 1.7 is ready!", { kind: "warning", action: { label: "Restart", onClick: () => {} } });
    toast("Face moved?", { action: { label: "Re-pick face", onClick: () => {} } });
    toast("Fillet 3 is stale.", { action: { label: "Rebuild", onClick: () => {} } });
    expect(announce.mock.calls).toEqual([
      ["Update 1.7 is ready! Restart button in Notifications.", "assertive", {}],
      ["Face moved? Re-pick face button in Notifications.", "polite", {}],
      ["Fillet 3 is stale. Rebuild button in Notifications.", "polite", {}],
    ]);
  });

  it("an announceKey reaches the announcer for info and warning", () => {
    toast("Build failed at Extrude 5", { kind: "warning", announceKey: "build-fail:e5" });
    toast("Opened 2 files", { announceKey: "opened" });
    expect(announce.mock.calls).toEqual([
      ["Build failed at Extrude 5", "assertive", { key: "build-fail:e5" }],
      ["Opened 2 files", "polite", { key: "opened" }],
    ]);
  });

  it("an error is spoken once, by the title bar notice, not again by the toast", () => {
    expect(toast("Could not save plate 7.funda", { kind: "error", announceKey: "save" })).toBeNull();
    expect(announce.mock.calls).toEqual([["Could not save plate 7.funda", "assertive", { key: "save" }]]);
  });

  it("two different toasts are two calls, in order", () => {
    toast("Pasted 4 faces");
    toast("Copied 9 edges", { kind: "warning" });
    expect(announce.mock.calls.map((c) => c[0])).toEqual(["Pasted 4 faces", "Copied 9 edges"]);
  });

  it("the same toast again is spoken again, once per call", () => {
    for (let i = 0; i < 3; i++) toast("Pasted 4 faces");
    expect(announce).toHaveBeenCalledTimes(3);
  });
});
