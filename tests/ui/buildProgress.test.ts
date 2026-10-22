import { describe, it, expect } from "vitest";
import { buildProgress, historyShowsBusy, historyShowsEmpty, runningRows, waitLabel } from "../../src/ui/buildProgress";

describe("buildProgress", () => {
  it("is indeterminate before the first progress report", () => {
    expect(buildProgress(null, null, null, 5)).toEqual({ label: "building…", pct: 0 });
  });

  it("counts features from 1, not 0", () => {
    // progress is a 0-based index; the chip has to read "building 1/5" on the
    // first feature or it looks stuck.
    expect(buildProgress(0, null, null, 5)).toEqual({ label: "building 1/5", pct: 20 });
    expect(buildProgress(4, null, null, 5)).toEqual({ label: "building 5/5", pct: 100 });
  });

  it("never reports past the total", () => {
    expect(buildProgress(9, null, null, 5).label).toBe("building 5/5");
  });

  it("survives an empty document without dividing by zero", () => {
    expect(buildProgress(0, null, null, 0).pct).toBe(0);
  });

  // The meshing (payload) phase reports feature = -1 for its WHOLE duration,
  // measured at 136s on the reference assembly, so without per-body counts it
  // renders as a bar pinned at 0% under a static label. These two cases are the
  // difference between "is it frozen?" and a progress bar.
  it("falls back to an indeterminate label when the engine sends no mesh counts", () => {
    expect(buildProgress(-1, null, null, 5)).toEqual({ label: "meshing…", pct: 0 });
    expect(buildProgress(-1, 3, 0, 5)).toEqual({ label: "meshing…", pct: 0 });
  });

  it("shows the real fraction once mesh counts arrive", () => {
    expect(buildProgress(-1, 3, 12, 5)).toEqual({ label: "meshing 3/12", pct: 25 });
    // a count running past the total must not read "13/12" or exceed 100%
    expect(buildProgress(-1, 13, 12, 5)).toEqual({ label: "meshing 12/12", pct: 100 });
  });
});

describe("waitLabel", () => {
  it("names an assistant by the name it gave, and says what it is doing", () => {
    expect(waitLabel({ who: "assistant", name: "Claude", op: "import" })).toBe("Waiting: Claude is importing a file");
    expect(waitLabel({ who: "assistant", op: "rebuild" })).toBe("Waiting: an AI assistant is building a model");
  });

  it("falls back to another session doing something", () => {
    expect(waitLabel({ who: "session", op: "frobnicate" })).toBe("Waiting: another session is working");
    expect(waitLabel({ who: "app", op: "export" })).toBe("Waiting: the app is exporting");
  });
});

const reb = { rebuild: true };
const imp = { rebuild: false };

describe("historyShowsEmpty", () => {
  it("keeps an empty document empty while its own rebuild waits, and when idle", () => {
    expect([historyShowsEmpty(0, [reb]), historyShowsEmpty(0, [])]).toEqual([true, true]);
  });

  it("gives way to an import into an empty document whichever op started last, and to any feature", () => {
    expect([
      historyShowsEmpty(0, [imp]),
      historyShowsEmpty(0, [imp, reb]),
      historyShowsEmpty(0, [reb, imp]),
      historyShowsEmpty(2, []),
    ]).toEqual([false, false, false, false]);
  });
});

describe("runningRows", () => {
  it("lists every op but the document's own rebuild, oldest first", () => {
    const a = { key: 1, rebuild: false };
    const b = { key: 2, rebuild: true };
    const c = { key: 3, rebuild: false };
    expect([runningRows([a, b, c]), runningRows([b]), runningRows([])]).toEqual([[a, c], [], []]);
  });
});

describe("historyShowsBusy", () => {
  const wait = { who: "assistant" as const, name: "Claude", op: "import" };

  it("says what an empty document's rebuild is waiting behind, with its Cancel", () => {
    expect(historyShowsBusy(0, { active: true, waiting: wait }, [reb])).toBe(true);
  });

  it("stays quiet for an empty document's own rebuild that is not waiting", () => {
    expect(historyShowsBusy(0, { active: true, waiting: null }, [reb])).toBe(false);
  });

  it("shows any other busy op, and nothing when idle", () => {
    expect([
      historyShowsBusy(0, { active: true, waiting: null }, [imp]),
      historyShowsBusy(0, { active: true, waiting: null }, [imp, reb]),
      historyShowsBusy(3, { active: true, waiting: null }, [reb]),
      historyShowsBusy(3, { active: false, waiting: null }, []),
    ]).toEqual([true, true, true, false]);
  });
});
