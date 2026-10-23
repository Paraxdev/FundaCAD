import { describe, it, expect } from "vitest";
import { BUILD_PHASE } from "../../src/geometry/buildPhase";
import {
  buildProgress,
  type BuildReport,
  historyShowsBusy,
  historyShowsEmpty,
  waitLabel,
} from "../../src/ui/buildProgress";

const P = BUILD_PHASE;
const steps = ["Sketch", "Extrude", "Fillet", "Hole", "Shell"];
const at = (r: Partial<BuildReport>) =>
  buildProgress({ phase: null, progress: null, meshed: null, meshTotal: null, ...r }, steps);

describe("buildProgress", () => {
  it("is indeterminate before the first progress report", () => {
    expect(at({})).toEqual({ label: "building…", pct: 0 });
  });

  it("says preparing, saving and collecting for the phases that run no feature", () => {
    expect(at({ phase: P.preparing }).label).toBe("preparing…");
    expect(at({ phase: P.saving }).label).toBe("saving a checkpoint…");
    expect(at({ phase: P.assembling }).label).toBe("collecting the result…");
    expect(at({ phase: P.applying })).toEqual({ label: "applying to the view…", pct: 100 });
  });

  it("names the running feature and counts from 1, not 0", () => {
    expect(at({ phase: P.feature, progress: 2 })).toEqual({ label: "Fillet 3/5", pct: 60 });
    expect(at({ phase: P.feature, progress: 4 })).toEqual({ label: "Shell 5/5", pct: 100 });
  });

  it("never reports past the total, and keeps a feature it has no name for", () => {
    expect(at({ phase: P.feature, progress: 9 })).toEqual({ label: "building 5/5", pct: 100 });
  });

  it("survives an empty document without dividing by zero", () => {
    expect(buildProgress({ phase: P.feature, progress: 0, meshed: null, meshTotal: null }, [])).toEqual({
      label: "building 0/0",
      pct: 0,
    });
  });

  it("falls back to an indeterminate label when meshing has no count", () => {
    expect(at({ phase: P.meshing })).toEqual({ label: "meshing…", pct: 0 });
    expect(at({ phase: P.meshing, meshed: 3, meshTotal: 0 })).toEqual({ label: "meshing…", pct: 0 });
  });

  it("counts the parts really meshed, one part singly", () => {
    expect(at({ phase: P.meshing, meshed: 3, meshTotal: 12 })).toEqual({ label: "meshing 3/12 parts", pct: 25 });
    expect(at({ phase: P.meshing, meshed: 13, meshTotal: 12 })).toEqual({ label: "meshing 12/12 parts", pct: 100 });
    expect(at({ phase: P.meshing, meshed: 0, meshTotal: 1 })).toEqual({ label: "meshing 1 part", pct: 0 });
  });

  // The fault: an edit with one body to mesh said "meshing" from 1 s in, through the copy, the fillet and the
  // checkpoint. Walk the phases of such an edit in the order the engine reports them.
  it("says meshing only while a body is being meshed", () => {
    const edit: BuildReport[] = [
      { phase: P.preparing, progress: -1, meshed: null, meshTotal: null },
      { phase: P.feature, progress: 4, meshed: null, meshTotal: null },
      { phase: P.saving, progress: -1, meshed: null, meshTotal: null },
      { phase: P.assembling, progress: -1, meshed: null, meshTotal: null },
      { phase: P.meshing, progress: -1, meshed: 0, meshTotal: 1 },
      { phase: P.assembling, progress: -1, meshed: null, meshTotal: null },
      { phase: P.applying, progress: null, meshed: null, meshTotal: null },
    ];
    const says = edit.map((r) => buildProgress(r, steps).label.includes("mesh"));
    expect(says).toEqual([false, false, false, false, true, false, false]);
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

describe("historyShowsEmpty", () => {
  it("keeps an empty document empty while its own rebuild waits", () => {
    expect(historyShowsEmpty(0, { active: true, rebuild: true })).toBe(true);
    expect(historyShowsEmpty(0, { active: false, rebuild: false })).toBe(true);
  });

  it("gives way to an import into an empty document, and to any feature", () => {
    expect(historyShowsEmpty(0, { active: true, rebuild: false })).toBe(false);
    expect(historyShowsEmpty(2, { active: false, rebuild: false })).toBe(false);
  });
});

describe("historyShowsBusy", () => {
  const wait = { who: "assistant" as const, name: "Claude", op: "import" };

  it("says what an empty document's rebuild is waiting behind, with its Cancel", () => {
    expect(historyShowsBusy(0, { active: true, rebuild: true, waiting: wait })).toBe(true);
  });

  it("stays quiet for an empty document's own rebuild that is not waiting", () => {
    expect(historyShowsBusy(0, { active: true, rebuild: true, waiting: null })).toBe(false);
  });

  it("shows any other busy op, and nothing when idle", () => {
    expect(historyShowsBusy(0, { active: true, rebuild: false, waiting: null })).toBe(true);
    expect(historyShowsBusy(3, { active: true, rebuild: true, waiting: null })).toBe(true);
    expect(historyShowsBusy(3, { active: false, rebuild: false, waiting: null })).toBe(false);
  });
});
