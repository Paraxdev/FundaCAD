import { describe, expect, it } from "vitest";
import { featureFailureReport } from "../../src/ui/errorReport";
import { dismissErrorNotice, errorNotice, showErrorNotice } from "../../src/ui/errorNotice";

const fillet = { id: "f7", type: "fillet", radius: 30 };
const detail = {
  index: 1,
  type: "fillet",
  ms: 12.5,
  kernel: [
    { op: "BRepAlgoAPI_Fuse", ms: 3 },
    { op: "BRepFilletAPI_MakeFillet", ms: 1, args: "shape=Solid(...), 1 edges, radii=[30]", error: "IsDone() is false" },
    { op: "BRepFilletAPI_MakeFillet", ms: 1, args: "shape=Solid(...), 1 edges, radii=[30]", error: "IsDone() is false" },
  ],
  bodies: [{ id: "body1", name: "Box", shape: "Solid(solids=1, faces=6, edges=12)" }],
  bodyCount: 1,
  params: { r: 30 },
  occt: "7.8.1",
};

describe("the feature failure report", () => {
  it("names the refusing OpenCASCADE call, its inputs, and the feature", () => {
    const text = featureFailureReport({ label: "Fillet1", message: "radius too large", feature: fillet, detail });
    expect(text).toContain("### Fillet1 failed");
    expect(text).toContain("`BRepFilletAPI_MakeFillet` raised `IsDone() is false`");
    expect(text).toContain("radii=[30]");
    expect(text).toContain("OpenCASCADE | 7.8.1");
    expect(text).toContain("#2 in the timeline");
    expect(text).toContain("`body1` Box: Solid(solids=1");
    expect(text).toContain("r = 30");
    expect(text).toContain('"radius": 30');
  });

  it("collapses a retried call into one line with a count", () => {
    const text = featureFailureReport({ label: "Fillet1", message: "x", feature: fillet, detail });
    expect(text).toContain("`BRepFilletAPI_MakeFillet` (x2)");
    expect(text).toContain("1. `BRepAlgoAPI_Fuse` 3 ms, ok");
  });

  it("says so when the engine sent no detail", () => {
    const text = featureFailureReport({ label: "Hole1", message: "no face" });
    expect(text).toContain("Not recorded");
  });
});

describe("the error notice channel", () => {
  it("counts a burst and resets once dismissed", () => {
    dismissErrorNotice();
    showErrorNotice("first", { logId: 1 });
    showErrorNotice("second", { logId: 2 });
    expect(errorNotice()).toMatchObject({ message: "second", logId: 2, count: 2 });
    dismissErrorNotice();
    showErrorNotice("third", { logId: 3 });
    expect(errorNotice()?.count).toBe(1);
    dismissErrorNotice();
  });
});
