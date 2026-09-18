import { describe, it, expect, beforeEach } from "vitest";
import {
  LOG_LIMIT,
  clearLog,
  consoleOpen,
  countByLevel,
  describe as describeValue,
  formatEntry,
  formatLog,
  log,
  logEntries,
  logError,
  onLogChange,
  setConsoleOpen,
  toggleConsole,
} from "../../src/ui/logStore";

beforeEach(() => {
  clearLog();
  setConsoleOpen(false);
});

describe("describe", () => {
  it("keeps a string exactly as it was", () => {
    // The whole point of the log is that the kernel's own sentence survives; any
    // reshaping here would defeat it at the first step.
    const s = "Fillet failed on Body1: Failed creating a chamfer, try a smaller length value(s)";
    expect(describeValue(s)).toBe(s);
  });

  it("keeps an Error's message and its stack", () => {
    const e = new Error("boom");
    const out = describeValue(e);
    expect(out).toContain("boom");
  });

  it("never renders an object as [object Object]", () => {
    // A logger that turns a real failure into "[object Object]" is worse than no
    // logger: it destroys the evidence while looking like it captured it. The
    // engine reports failures as objects, so this is the common path.
    const out = describeValue({ feature_id: "f5", message: "worker died" });
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("f5");
    expect(out).toContain("worker died");
  });

  it("survives a value that cannot be stringified", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => describeValue(cyclic)).not.toThrow();
    expect(describeValue(cyclic).length).toBeGreaterThan(0);
  });

  it("does not lose null and undefined", () => {
    expect(describeValue(null)).toBe("null");
    expect(describeValue(undefined)).toBe("undefined");
  });
});

describe("the log", () => {
  it("keeps the message whole, however long", () => {
    // The reason this module exists: the toast clips with ellipsis and the title
    // bar pill clips harder, and the clipped tail is the part that says what to
    // do about it.
    const long = "x".repeat(4000);
    logError(long);
    expect(logEntries()[0]!.message).toHaveLength(4000);
  });

  it("hands entries back oldest first", () => {
    logError("first");
    logError("second");
    expect(logEntries().map((e) => e.message)).toEqual(["first", "second"]);
  });

  it("drops the OLDEST once it is full, never the newest", () => {
    // A rebuild that fails on every frame of a drag emits a message per frame,
    // so this has to be a ring or a misbehaving preview becomes a memory leak.
    // Dropping the newest would throw away the error the user is looking at.
    for (let i = 0; i < LOG_LIMIT + 25; i++) logError(`e${i}`);
    const all = logEntries();
    expect(all).toHaveLength(LOG_LIMIT);
    expect(all[all.length - 1]!.message).toBe(`e${LOG_LIMIT + 24}`);
    expect(all[0]!.message).toBe("e25");
  });

  it("gives every entry a distinct id even at the same millisecond", () => {
    // The list renders by id; duplicates would make Vue reuse a row and show one
    // error's text under another's timestamp.
    for (let i = 0; i < 50; i++) logError("same");
    expect(new Set(logEntries().map((e) => e.id)).size).toBe(50);
  });

  it("counts by level for the badge", () => {
    logError("a");
    log("warning", "b");
    log("info", "c");
    expect(countByLevel("error")).toBe(1);
    expect(countByLevel("warning")).toBe(1);
    expect(countByLevel("info")).toBe(1);
  });

  it("notifies listeners on write, clear and open/close", () => {
    let n = 0;
    const off = onLogChange(() => n++);
    logError("x");
    expect(n).toBe(1);
    clearLog();
    expect(n).toBe(2);
    toggleConsole();
    expect(n).toBe(3);
    off();
    logError("y");
    expect(n).toBe(3);
  });

  it("does not notify when the open state is set to what it already is", () => {
    // The panel re-reads on every notification; a no-op write that still fired
    // would turn an idle app into a render loop.
    setConsoleOpen(false);
    let n = 0;
    const off = onLogChange(() => n++);
    setConsoleOpen(false);
    expect(n).toBe(0);
    setConsoleOpen(true);
    expect(n).toBe(1);
    expect(consoleOpen()).toBe(true);
    off();
  });
});

describe("formatting for the clipboard", () => {
  it("carries the level, the source and the whole message", () => {
    const e = log("error", "kernel said no", { source: "rebuild", detail: "f5: press-pull" });
    const text = formatEntry(e);
    expect(text).toContain("ERROR");
    expect(text).toContain("[rebuild]");
    expect(text).toContain("kernel said no");
    expect(text).toContain("f5: press-pull");
  });

  it("copies the whole log as plain text with entries separated", () => {
    logError("one");
    logError("two");
    const text = formatLog();
    expect(text).toContain("one");
    expect(text).toContain("two");
    expect(text.split("\n\n")).toHaveLength(2);
  });
});
