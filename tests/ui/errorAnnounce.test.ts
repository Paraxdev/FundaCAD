// Every error notice is spoken assertively, and a step's failure that both the build line and its error toast report
// is said once.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";

type Announce = typeof import("../../src/ui/announce");
type Notice = typeof import("../../src/ui/errorNotice");
type Toast = typeof import("../../src/ui/toast");

let a: Announce;
let n: Notice;
let t: Toast;
let failureKey: (id: string) => string;
let polite: { textContent: string | null };
let assertive: { textContent: string | null };

beforeEach(async () => {
  setActivePinia(createPinia());
  vi.useFakeTimers();
  vi.resetModules();
  a = await import("../../src/ui/announce");
  n = await import("../../src/ui/errorNotice");
  t = await import("../../src/ui/toast");
  ({ failureKey } = await import("../../src/ui/buildAnnouncement"));
  polite = { textContent: "" };
  assertive = { textContent: "" };
  a.attachAnnouncer({ polite, assertive });
});
afterEach(() => {
  n.dismissErrorNotice();
  vi.useRealTimers();
});

const frame = () => vi.advanceTimersByTime(20);

describe("spoken errors", () => {
  it("an error notice is spoken in the assertive region", () => {
    n.showErrorNotice("Could not save plate.funda", { logId: 1 });
    frame();
    expect(assertive.textContent).toBe("Could not save plate.funda");
    expect(polite.textContent).toBe("");
  });

  it("an error toast reaches the announcer through its notice", () => {
    t.toast("Export failed: disk full", { kind: "error" });
    frame();
    expect(assertive.textContent).toBe("Export failed: disk full");
  });

  it("a step's build line and its error toast in one frame are said once", () => {
    a.announce("Build failed at Extrude 1: Profile is open", "assertive", { key: failureKey("f1") });
    t.toast("Extrude 1 failed: Profile is open", { kind: "error", announceKey: failureKey("f1") });
    frame();
    expect(assertive.textContent).toBe("Extrude 1 failed: Profile is open");
  });

  it("another step failing in the same build is still said", () => {
    a.announce("Build failed at Extrude 1: Profile is open", "assertive", { key: failureKey("f1") });
    t.toast("Fillet 2 failed: Radius too large", { kind: "error", announceKey: failureKey("f2") });
    frame();
    expect(assertive.textContent).toBe("Build failed at Extrude 1: Profile is open. Fillet 2 failed: Radius too large");
  });

  it("is silent at the Off verbosity and still spoken at Errors", () => {
    a.setVerbositySource(() => "off");
    n.showErrorNotice("Could not open", { logId: 2 });
    frame();
    expect(assertive.textContent).toBe("");
    a.setVerbositySource(() => "errors");
    n.showErrorNotice("Could not open", { logId: 3 });
    frame();
    expect(assertive.textContent).toBe("Could not open");
  });
});
