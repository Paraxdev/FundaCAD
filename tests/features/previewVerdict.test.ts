import { describe, expect, it } from "vitest";
import { previewVerdict } from "../../src/features/previewVerdict";

const state = (hasPreview: boolean, building: boolean, previewError: string | null) =>
  ({ hasPreview, previewError, buildState: { building } });

describe("previewVerdict", () => {
  it("commits a tool with no kernel preview straight away", () => {
    expect(previewVerdict(state(false, true, null))).toEqual({ kind: "commit" });
  });
  it("waits while the preview is still building", () => {
    expect(previewVerdict(state(true, true, "old refusal"))).toEqual({ kind: "wait" });
  });
  it("refuses a preview the kernel refused, with its reason", () => {
    expect(previewVerdict(state(true, false, "too thick"))).toEqual({ kind: "refused", reason: "too thick" });
  });
  it("commits a preview that built", () => {
    expect(previewVerdict(state(true, false, null))).toEqual({ kind: "commit" });
  });
});
