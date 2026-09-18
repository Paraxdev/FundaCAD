import { describe, it, expect } from "vitest";
import {
  MAX_DIAGONAL_FRACTION,
  MIN_EDGE_VALUE,
  clampValue,
  dragLimit,
  otherTreatment,
  scrubSigned,
  blendRefusalReason,
  blendVerdict,
  commitDecision,
  EMPTY_BLEND_RANGE,
  noteBlendOutcome,
  seedValue,
  switchTreatment,
  treatmentAt,
  treatmentField,
  treatmentLabel,
  valueBounds,
} from "../../src/features/edgeDragMath";

describe("treatmentField", () => {
  it("names the field each treatment actually stores its value in", () => {
    // These strings are read straight into the Feature and into the heads-up
    // input's label; getting them the wrong way round writes a chamfer's
    // setback into a fillet's radius.
    expect(treatmentField("fillet")).toEqual({ name: "radius", label: "R" });
    expect(treatmentField("chamfer")).toEqual({ name: "distance", label: "D" });
  });

  it("labels both treatments for the prompt line", () => {
    expect(treatmentLabel("fillet")).toBe("Fillet");
    expect(treatmentLabel("chamfer")).toBe("Chamfer");
  });
});

describe("otherTreatment", () => {
  it("is its own inverse", () => {
    expect(otherTreatment("fillet")).toBe("chamfer");
    expect(otherTreatment("chamfer")).toBe("fillet");
    expect(otherTreatment(otherTreatment("fillet"))).toBe("fillet");
  });
});

describe("dragLimit", () => {
  it("caps a dragged value at a fraction of the model's diagonal", () => {
    expect(dragLimit(100)).toBeCloseTo(100 * MAX_DIAGONAL_FRACTION);
  });

  it("is unbounded when the model has no bbox yet", () => {
    // An empty document still has to let the tool arm without dividing the
    // gesture by a diagonal that does not exist.
    expect(dragLimit(null)).toBe(Infinity);
    expect(dragLimit(0)).toBe(Infinity);
    expect(dragLimit(Number.NaN)).toBe(Infinity);
  });

  it("still leaves room for the smallest buildable blend on a tiny model", () => {
    expect(dragLimit(0.0001)).toBeGreaterThanOrEqual(MIN_EDGE_VALUE);
  });

  it("leaves room for a full round on a cube", () => {
    // The reported complaint is a drag that stops far short of what the kernel
    // will build. A 40mm cube rounds to a 20mm sphere at the limit, and its
    // diagonal is 69.3, so anything under 0.29 of the diagonal cannot reach a
    // shape the kernel would have made.
    expect(dragLimit(Math.sqrt(3) * 40)).toBeGreaterThanOrEqual(20);
  });
});

describe("noteBlendOutcome", () => {
  const fold = (steps: [number, boolean][]) =>
    steps.reduce((r, [v, ok]) => noteBlendOutcome(r, v, ok), EMPTY_BLEND_RANGE);

  it("records the largest size that built and the smallest that did not", () => {
    expect(fold([[1, true], [2, true], [4, false], [5, false]])).toEqual({ built: 2, refused: 4 });
  });

  it("lets a refusal drop a success recorded at the same size", () => {
    const r = fold([[2.2, true], [2.2, false]]);
    expect(r.refused).toBe(2.2);
    expect(r.built).toBeNull();
  });

  it("does not let a late success climb back over a refusal", () => {
    expect(fold([[1, true], [3, false], [4, true]]).built).toBe(1);
  });

  it("ignores a value that is not a size", () => {
    expect(noteBlendOutcome(EMPTY_BLEND_RANGE, 0, false)).toBe(EMPTY_BLEND_RANGE);
    expect(noteBlendOutcome(EMPTY_BLEND_RANGE, Number.NaN, true)).toBe(EMPTY_BLEND_RANGE);
  });
});

describe("blendVerdict", () => {
  // The pocket from the reference flow: a 40mm deep, 40mm radius pocket whose
  // floor edge builds at 39.9 and is refused from 40 up.
  const pocket = { built: 39.9, refused: 40 };

  it("knows nothing before the kernel has answered", () => {
    expect(blendVerdict(EMPTY_BLEND_RANGE, 10)).toBe("unknown");
  });

  it("refuses the refused size and everything past it without asking again", () => {
    expect(blendVerdict(pocket, 40)).toBe("refused");
    expect(blendVerdict(pocket, 55)).toBe("refused");
  });

  it("comes back the moment the drag is under the refusal", () => {
    expect(blendVerdict(pocket, 39.9)).toBe("builds");
    expect(blendVerdict(pocket, 12)).toBe("builds");
    expect(blendVerdict({ built: 30, refused: 40 }, 35)).toBe("unknown");
  });

  it("is not fooled by float fuzz at the refused size", () => {
    expect(blendVerdict(pocket, 39.999999999999986)).toBe("refused");
  });

  it("has no opinion on a value that is not a size", () => {
    expect(blendVerdict(pocket, 0)).toBe("unknown");
    expect(blendVerdict(pocket, Number.NaN)).toBe("unknown");
  });
});

describe("commitDecision", () => {
  const base = { value: 41, verdict: "refused" as const, settled: false, shown: 39.8, typed: false };

  it("commits the size on screen when the dragged size is refused", () => {
    expect(commitDecision(base)).toEqual({ action: "commit", value: 39.8 });
  });

  it("cancels rather than adding a broken feature when nothing ever built", () => {
    expect(commitDecision({ ...base, shown: null })).toEqual({ action: "cancel" });
  });

  it("keeps the tool open on a refused TYPED value", () => {
    expect(commitDecision({ ...base, typed: true })).toEqual({ action: "stay" });
  });

  it("commits a value whose own preview built", () => {
    expect(commitDecision({ ...base, value: 30, verdict: "builds", settled: true, shown: 30 }))
      .toEqual({ action: "commit", value: 30 });
  });

  it("waits for the kernel on a value it has not answered for yet", () => {
    // Released mid round-trip: committing now would be a guess.
    expect(commitDecision({ ...base, verdict: "unknown", shown: 30 })).toEqual({ action: "wait" });
    expect(commitDecision({ ...base, value: 20, verdict: "builds", shown: 30 })).toEqual({ action: "wait" });
  });
});

describe("blendRefusalReason", () => {
  const tooBig = { code: "blendTooLarge", message: "Fillet failed on Body1: Failed creating a fillet with radius of 40.0, try a smaller value" };

  it("says what a too-large blend means, per treatment and edge count", () => {
    expect(blendRefusalReason("fillet", 1, tooBig)).toBe("Radius too large for the faces around this edge");
    expect(blendRefusalReason("chamfer", 3, tooBig)).toBe("Distance too large for the faces around these edges");
  });

  it("reads the older uncoded wording the same way", () => {
    expect(blendRefusalReason("fillet", 1, { ...tooBig, code: null })).toBe(
      "Radius too large for the faces around this edge",
    );
  });

  it("never tells someone to go smaller when size is not the problem", () => {
    const r = blendRefusalReason("fillet", 1, { code: "edgeAlreadySmooth", message: "can't fillet here" });
    expect(r).not.toMatch(/smaller|too large/i);
  });

  it("passes an unrecognised refusal through without the body prefix", () => {
    expect(blendRefusalReason("fillet", 1, { code: null, message: "Fillet failed on Body1: something odd" }))
      .toBe("something odd");
  });
});

describe("valueBounds", () => {
  it("floors a chosen value at the smallest visible blend, not at zero", () => {
    expect(valueBounds(100).min).toBe(MIN_EDGE_VALUE);
    expect(valueBounds(100).max).toBeCloseTo(100 * MAX_DIAGONAL_FRACTION);
  });

  it("never produces max < min", () => {
    const b = valueBounds(1e-9);
    expect(b.max).toBeGreaterThanOrEqual(b.min);
  });
});

describe("clampValue", () => {
  const bounds = { min: 0.5, max: 25 };

  it("holds the value inside the bounds", () => {
    expect(clampValue(10, bounds)).toBe(10);
    expect(clampValue(-3, bounds)).toBe(0.5);
    expect(clampValue(1e6, bounds)).toBe(25);
  });

  it("treats a non-finite value as the floor rather than propagating NaN", () => {
    // axisDragDistance can return NaN at a degenerate camera angle; letting it
    // through would write NaN into the Feature and fail the rebuild silently.
    expect(clampValue(Number.NaN, bounds)).toBe(0.5);
    expect(clampValue(Infinity, bounds)).toBe(0.5);
  });
});

describe("scrubSigned", () => {
  const limit = 25;

  it("is relative to the grab, so grabbing the handle never jumps the value", () => {
    // proj === grabProj is the instant of the press: the value must be exactly
    // what it already was, whatever absolute position the handle sits at.
    expect(scrubSigned({ grabSigned: 3, grabProj: 117.4, proj: 117.4, step: 0.5, limit })).toBe(3);
  });

  it("adds the travel along the axis", () => {
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: 4, step: 0.5, limit })).toBe(6);
    expect(scrubSigned({ grabSigned: 6, grabProj: 4, proj: 0, step: 0.5, limit })).toBe(2);
  });

  it("snaps to the step so the readout reads as a round number", () => {
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: 0.9713, step: 0.5, limit })).toBe(3);
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: 0.1, step: 0.5, limit })).toBe(2);
  });

  it("strips float fuzz rather than emitting 0.30000000000000004", () => {
    expect(scrubSigned({ grabSigned: 0.1, grabProj: 0, proj: 0.2, step: 0.1, limit })).toBe(0.3);
  });

  it("passes THROUGH zero into the other treatment's side", () => {
    // The whole point of the redesign: dragging back past the edge used to park
    // at a floor, which made "I meant a chamfer" an abort-and-restart.
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: -5, step: 0.5, limit })).toBe(-3);
  });

  it("holds a one-step dead zone at the origin so the abort is reachable", () => {
    // Half a step is ~4px of travel, too fine to stop in on purpose, and this
    // is the state the user backs out of the gesture in.
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: -2.4, step: 0.5, limit })).toBe(0);
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: -1.6, step: 0.5, limit })).toBe(0);
    // ...and one clean step past it, not a fraction of one
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: -2.55, step: 0.5, limit })).toBe(-0.5);
  });

  it("caps the same distance either side of the origin", () => {
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: 10_000, step: 0.5, limit })).toBe(25);
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: -10_000, step: 0.5, limit })).toBe(-25);
  });

  it("keeps giving the same answer once clamped, so the tool stops rebuilding", () => {
    // edgeFeatureTool skips the engine round-trip when the stepped value is
    // unchanged; a clamp that drifted would rebuild on every pointermove for
    // the whole time the cursor stayed off the end of the drag.
    const a = scrubSigned({ grabSigned: 2, grabProj: 0, proj: 900, step: 0.5, limit });
    const b = scrubSigned({ grabSigned: 2, grabProj: 0, proj: 901, step: 0.5, limit });
    expect(a).toBe(b);
  });

  it("reads a degenerate projection as the origin rather than NaN", () => {
    // axisDragDistance can return NaN at a degenerate camera angle; letting it
    // through would write NaN into the Feature and fail the rebuild silently.
    expect(scrubSigned({ grabSigned: 2, grabProj: 0, proj: Number.NaN, step: 0.5, limit })).toBe(0);
  });
});

describe("treatmentAt", () => {
  it("gives the arrow's own treatment on the positive side", () => {
    expect(treatmentAt("fillet", 3)).toEqual({ kind: "fillet", value: 3 });
    expect(treatmentAt("chamfer", 3)).toEqual({ kind: "chamfer", value: 3 });
  });

  it("gives the opposite treatment, same magnitude, on the far side", () => {
    // Same drag distance, other side of the edge: a 3 mm radius becomes a 3 mm
    // setback. That equivalence is why one axis can carry both.
    expect(treatmentAt("fillet", -3)).toEqual({ kind: "chamfer", value: 3 });
    expect(treatmentAt("chamfer", -3)).toEqual({ kind: "fillet", value: 3 });
  });

  it("values the origin at nothing", () => {
    expect(treatmentAt("fillet", 0).value).toBe(0);
  });
});

describe("switchTreatment", () => {
  it("carries the number across untouched, that is the whole gesture", () => {
    const bounds = { min: 0.5, max: 25 };
    expect(switchTreatment("fillet", 4.5, bounds)).toEqual({ kind: "chamfer", value: 4.5 });
    expect(switchTreatment("chamfer", 4.5, bounds)).toEqual({ kind: "fillet", value: 4.5 });
  });

  it("round-trips back to the original treatment and value", () => {
    const bounds = { min: 0.5, max: 25 };
    const once = switchTreatment("fillet", 7, bounds);
    expect(switchTreatment(once.kind, once.value, bounds)).toEqual({ kind: "fillet", value: 7 });
  });

  it("re-clamps a value that came from a different bounds regime", () => {
    // e.g. the user typed 900, then flipped: the flip must not smuggle an
    // out-of-range value into the other treatment's drag.
    expect(switchTreatment("fillet", 900, { min: 0.5, max: 25 }).value).toBe(25);
  });
});

describe("seedValue", () => {
  it("opens on the familiar MCAD defaults", () => {
    const roomy = { min: 0.1, max: 100 };
    expect(seedValue("fillet", roomy)).toBe(2);
    expect(seedValue("chamfer", roomy)).toBe(1);
  });

  it("shrinks the default on a model too small to hold it", () => {
    // A default nobody can build is worse than a small one: it would open the
    // gesture on a preview that fails before the user has touched anything.
    expect(seedValue("fillet", { min: 0.05, max: 0.5 })).toBe(0.5);
  });

  it("opens inside what the neighbourhood measured, without being walled by it", () => {
    // The clearance's whole remaining job. It picks a plausible OPENING value...
    const roomy = { min: 0.1, max: 100 };
    expect(seedValue("fillet", roomy, 0.4)).toBeCloseTo(0.4);
    // ...and a roomy measurement never inflates the familiar default.
    expect(seedValue("fillet", roomy, 50)).toBe(2);
    // Not measured stays not measured.
    expect(seedValue("fillet", roomy, null)).toBe(2);
    expect(seedValue("fillet", roomy, 0)).toBe(2);
    expect(seedValue("fillet", roomy, Number.NaN)).toBe(2);
  });
});
