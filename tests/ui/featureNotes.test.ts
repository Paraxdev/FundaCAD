// The rule that decides which chip goes amber.
//
// Two lists arrive from a build and they overlap: `featureErrors` says what
// went wrong, `diagnostics` says everything the engine noticed on the way,
// including entries for features that then failed for an unrelated reason. One
// chip, one tooltip, so exactly one of them has to be chosen.
//
// The case that matters is the third one. A cut that seals a void AND fails is
// red, not amber: an advisory about a result that was thrown away, stacked on
// top of the failure that threw it away, is noise where the error is the useful
// sentence. Getting that backwards paints a failed feature as a successful one.

import { afterEach, describe, it, expect } from "vitest";
import { setLanguage } from "../../src/i18n";
import { featureFailures, featureNotes, featurePlaceholders, placeholderNote } from "../../src/ui/featureNotes";
import { setUnit } from "../../src/ui/units";

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

describe("featureFailures", () => {
  const held = { featureId: "p1" };

  it("leaves a held preview's refusal out of the badge", () => {
    const state = {
      featureErrors: [],
      errorFeatureId: "p1",
      errorMessage: "too small for its walls",
      heldRefusal: held,
    };
    expect(featureFailures(state).size).toBe(0);
  });

  it("still counts a committed feature that fails, held refusal or not", () => {
    const failed = { feature_id: "f3", message: "fillet is larger than the edge" };
    expect([...featureFailures({ featureErrors: [failed], errorFeatureId: "p1", heldRefusal: held }).keys()]).toEqual([
      "f3",
    ]);
    expect(featureFailures({ errorFeatureId: "f3", errorMessage: "fillet is larger than the edge" }).get("f3")).toBe(
      "fillet is larger than the edge",
    );
  });

  it("counts a preview that failed without asking to be held", () => {
    expect([...featureFailures({ errorFeatureId: "p1", errorMessage: "no" }).keys()]).toEqual(["p1"]);
  });
});

describe("featurePlaceholders", () => {
  it("names each feature the build left out by its type", () => {
    const p = featurePlaceholders({
      skippedFeatures: [
        { feature_id: "w1", type: "futureWidget" },
        { feature_id: "w2", type: "fooBar" },
      ],
    });
    expect([...p]).toEqual([
      ["w1", "futureWidget"],
      ["w2", "fooBar"],
    ]);
  });

  it("is empty for a build that skipped nothing", () => {
    expect(featurePlaceholders({}).size).toBe(0);
  });
});

describe("placeholderNote", () => {
  it("names the plugin when a shipped one declares the type", () => {
    expect(placeholderNote("texture")).toBe(
      'Not included: it needs the "Surface Texture" plugin, which is not running here. It is kept and saved with the file.',
    );
  });

  it("says this version does not know a type nothing here declares", () => {
    expect(placeholderNote("futureWidget")).toContain("this version of FundaCAD does not know this feature type");
  });
});

describe("an oversize blend's note", () => {
  const reason = (what: string, fits = " A fillet that rests on both fits up to 4.99mm.") =>
    `at 6mm the ${what} runs past a face beside the edge through (0, -10, 10) on body1, so it cuts that corner off ` +
    `instead of resting on both faces.${fits.replace("fillet", what)}`;
  const note = (r: string) => featureNotes({ diagnostics: [{ feature_id: "e3", code: "blendOverrun", reason: r }] });

  afterEach(async () => {
    setUnit("mm");
    await setLanguage("system");
  });

  it("lights the chip and names the size that rests on both faces", () => {
    expect(note(reason("fillet")).get("e3")).toBe(
      "The fillet runs past a face beside its edge, so it cuts that corner off instead of resting on both faces. " +
        "One that rests on both fits up to 4.99 mm.",
    );
  });

  it("says chamfer for a chamfer, and leaves the size out when the engine names none", () => {
    expect(note(reason("chamfer", "")).get("e3")).toBe(
      "The chamfer runs past a face beside its edge, so it cuts that corner off instead of resting on both faces.",
    );
  });

  it("reads the kind from the engine's sentence, not from a body named Chamfer", () => {
    expect(note(reason("fillet").replace("body1", "Chamfer")).get("e3")).toMatch(/^The fillet runs past/);
  });

  it("replaces an earlier lossy match's note for the same feature", () => {
    const notes = featureNotes({
      diagnostics: [
        { feature_id: "e3", lossy: true, reason: "edge picked from a drifted match" },
        { feature_id: "e3", code: "blendOverrun", reason: reason("fillet") },
      ],
    });
    expect(notes.get("e3")).toMatch(/^The fillet runs past/);
  });

  it("follows the chosen language and its decimal mark", async () => {
    await setLanguage("de");
    const text = note(reason("fillet")).get("e3");
    expect(text).toContain("Verrundung");
    expect(text).toContain("4,99 mm");
    expect(text).not.toContain("runs past");
  });

  it("never names a size in inches past the one that fits", () => {
    setUnit("in");
    // 9.99 mm is 0.3933 in, shown to the nearest digit it would read 0.394 in
    expect(note(reason("fillet", " A fillet that rests on both fits up to 9.99mm.")).get("e3")).toMatch(/0\.393 in\.$/);
  });

  it("shows the engine's own reason for an advisory the app does not word", () => {
    expect(featureNotes({ diagnostics: [{ feature_id: "e3", code: "sealedVoid", reason: "as sent" }] }).get("e3")).toBe(
      "as sent",
    );
  });
});
