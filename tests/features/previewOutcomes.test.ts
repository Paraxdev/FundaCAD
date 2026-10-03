// The record press/pull and offset face keep of what the kernel said about
// each preview a drag sent: what built, what was refused and why, and which
// one the model on screen holds.

import { describe, expect, it } from "vitest";
import { featureKey, PreviewOutcomes, type BuildReply } from "../../src/features/previewOutcomes";
import type { Feature } from "../../src/types";

const FACE = { kind: "face", by: "nearest", point: [0, 9.125, 20] } as const;
const push = (distance: number, id = "f9"): Feature =>
  ({ id, type: "press-pull", faces: FACE, distance, followTangent: true }) as unknown as Feature;

const built = (f: Feature): BuildReply => ({ previewBuilt: [f], heldRefusal: null, errorFeatureId: null, errorMessage: null });
const refused = (f: Feature, message: string): BuildReply => ({
  previewBuilt: [f],
  heldRefusal: { featureId: f.id, message, code: null, diagnostics: [] },
  errorFeatureId: null,
  errorMessage: null,
});

const outcomes = () => new PreviewOutcomes(/^Press\/Pull[^:]*:\s*/i);

describe("PreviewOutcomes", () => {
  it("keys a preview by everything but its id", () => {
    expect(featureKey(push(1, "a"))).toBe(featureKey(push(1, "b")));
    expect(featureKey(push(1))).not.toBe(featureKey(push(2)));
  });

  it("holds the last size that built while a later one is refused", () => {
    const o = outcomes();
    o.note(built(push(1)), "f9");
    o.note(refused(push(-3), "Press/Pull f9: the walls would be left behind"), "f9");
    expect(o.shownFeature).toEqual(push(1));
    expect(o.verdict(featureKey(push(1)))).toBe("builds");
    expect(o.verdict(featureKey(push(-3)))).toBe("refused");
    expect(o.verdict(featureKey(push(2)))).toBe("unknown");
    expect(o.isRefused(featureKey(push(-3)))).toBe(true);
  });

  it("drops the feature name a refusal leads with", () => {
    const o = outcomes();
    o.note(refused(push(-3), "Press/Pull f9: the walls would be left behind"), "f9");
    expect(o.refresh(featureKey(push(-3)))).toBe(true);
    expect(o.refusal).toBe("the walls would be left behind");
  });

  it("ignores a reply for another tool's preview", () => {
    const o = outcomes();
    o.note(built(push(1, "other")), "f9");
    expect(o.shownFeature).toBeNull();
    expect(o.verdict(featureKey(push(1)))).toBe("unknown");
  });

  it("takes nothing as built from a build that failed elsewhere", () => {
    const o = outcomes();
    o.note({ ...built(push(1)), errorMessage: "kernel crashed" }, "f9");
    expect(o.verdict(featureKey(push(1)))).toBe("unknown");
    o.note({ ...built(push(1)), errorFeatureId: "f2", errorMessage: "f2 failed" }, "f9");
    expect(o.verdict(featureKey(push(1)))).toBe("builds");
  });

  it("keeps a refusal up until a value builds, and takes it down for no push", () => {
    const o = outcomes();
    o.note(refused(push(-3), "too small"), "f9");
    o.refresh(featureKey(push(-3)));
    expect(o.refresh(featureKey(push(-2.5)))).toBe(false);
    expect(o.refusal).toBe("too small");
    o.note(built(push(-2.5)), "f9");
    expect(o.refresh(featureKey(push(-2.5)))).toBe(true);
    expect(o.refusal).toBeNull();
    o.refresh(featureKey(push(-3)));
    expect(o.refresh(null)).toBe(true);
    expect(o.refusal).toBeNull();
  });

  it("is settled only once the reply for that very preview is on screen", () => {
    const o = outcomes();
    o.note(built(push(1)), "f9");
    expect(o.settled(featureKey(push(1)))).toBe(true);
    expect(o.settled(featureKey(push(1.5)))).toBe(false);
  });

  it("offers the shown preview only for the same question", () => {
    const o = outcomes();
    o.note(built(push(1)), "f9");
    expect(o.shownFor(push(4), ["distance"])).toEqual(push(1));
    const unfollowed = { ...push(4), followTangent: false } as unknown as Feature;
    expect(o.shownFor(unfollowed, ["distance"])).toBeNull();
  });

  it("forgets the answers but leaves the refusal to the next refresh, and clear takes both", () => {
    const o = outcomes();
    o.note(refused(push(-3), "too small"), "f9");
    o.refresh(featureKey(push(-3)));
    o.forget();
    expect(o.verdict(featureKey(push(-3)))).toBe("unknown");
    expect(o.refusal).toBe("too small");
    o.clear();
    expect(o.refusal).toBeNull();
  });
});
