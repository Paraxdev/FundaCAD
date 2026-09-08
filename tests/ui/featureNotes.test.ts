// The rule that decides which chip goes amber.
//
// Two lists arrive from a build and they overlap: `featureErrors` says what
// went wrong, `diagnostics` says everything the sidecar noticed on the way,
// including entries for features that then failed for an unrelated reason. One
// chip, one tooltip, so exactly one of them has to win.
//
// The case that matters is the third one. A cut that seals a void AND fails is
// red, not amber: an advisory about a result that was thrown away, stacked on
// top of the failure that threw it away, is noise where the error is the useful
// sentence. Getting that backwards paints a failed feature as a successful one.

import { describe, it, expect } from "vitest";
import { featureNotes } from "../../src/ui/featureNotes";

describe("featureNotes", () => {
  it("is empty when a build reported nothing", () => {
    expect(featureNotes({}).size).toBe(0);
    expect(featureNotes({ diagnostics: [], featureErrors: [] }).size).toBe(0);
  });

  it("carries a diagnostic's reason for a feature that built", () => {
    const notes = featureNotes({
      diagnostics: [{ feature_id: "e2", reason: "This cut closed a cavity inside the body." }],
    });
    expect(notes.get("e2")).toBe("This cut closed a cavity inside the body.");
  });

  it("says nothing about a feature that FAILED, whichever list named it", () => {
    const diag = [{ feature_id: "e2", reason: "advisory" }];
    expect(featureNotes({ diagnostics: diag, featureErrors: [{ feature_id: "e2" }] }).size).toBe(0);
    expect(featureNotes({ diagnostics: diag, errorFeatureId: "e2" }).size).toBe(0);
  });

  it("still speaks about the features that did NOT fail in the same build", () => {
    const notes = featureNotes({
      featureErrors: [{ feature_id: "e2" }],
      diagnostics: [
        { feature_id: "e2", reason: "thrown away with the failure" },
        { feature_id: "e5", reason: "worth saying" },
      ],
    });
    expect([...notes]).toEqual([["e5", "worth saying"]]);
  });

  it("takes the FIRST reason per feature, because the chip shows one", () => {
    const notes = featureNotes({
      diagnostics: [
        { feature_id: "e2", reason: "first" },
        { feature_id: "e2", reason: "second" },
      ],
    });
    expect(notes.get("e2")).toBe("first");
  });

  it("skips a diagnostic with nothing to say, rather than lighting an empty tooltip", () => {
    const notes = featureNotes({
      diagnostics: [{ feature_id: "e2" }, { reason: "orphaned, names no feature" }],
    });
    expect(notes.size).toBe(0);
  });

  it("tolerates a build with a null error id, which is what it holds between builds", () => {
    const notes = featureNotes({
      errorFeatureId: null,
      diagnostics: [{ feature_id: "e2", reason: "still shown" }],
    });
    expect(notes.get("e2")).toBe("still shown");
  });
});
