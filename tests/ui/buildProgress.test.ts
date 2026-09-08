import { describe, it, expect } from "vitest";
import { buildProgress } from "../../src/ui/buildProgress";

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
  it("falls back to an indeterminate label when the sidecar sends no mesh counts", () => {
    expect(buildProgress(-1, null, null, 5)).toEqual({ label: "meshing…", pct: 0 });
    expect(buildProgress(-1, 3, 0, 5)).toEqual({ label: "meshing…", pct: 0 });
  });

  it("shows the real fraction once mesh counts arrive", () => {
    expect(buildProgress(-1, 3, 12, 5)).toEqual({ label: "meshing 3/12", pct: 25 });
    // a count running past the total must not read "13/12" or exceed 100%
    expect(buildProgress(-1, 13, 12, 5)).toEqual({ label: "meshing 12/12", pct: 100 });
  });
});
