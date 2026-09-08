import { describe, it, expect, vi } from "vitest";
import { remapSelection, MAX_GEOMETRIC_REMATCH } from "../../src/viewport/selectionMemo";

/** A memo is opaque to the policy, so a bare label is enough to trace one. */
type Memo = { tag: string };
const memos = (...tags: string[]): Memo[] => tags.map((tag) => ({ tag }));

describe("remapSelection", () => {
  it("keeps survivors and never pays for the fallback", () => {
    const rematch = vi.fn(() => null);
    const out = remapSelection(memos("a", "b"), (m) => m.tag, rematch);
    expect(out).toEqual(["a", "b"]);
    // The whole point of the survivor path: a rebuild that touched one body out
    // of hundreds must not walk the model once per selected entity.
    expect(rematch).not.toHaveBeenCalled();
  });

  it("falls back geometrically only for what did not survive", () => {
    const rematch = vi.fn((m: Memo) => `${m.tag}'`);
    const out = remapSelection(
      memos("a", "b", "c"),
      (m) => (m.tag === "b" ? null : m.tag),
      rematch,
    );
    expect(out).toEqual(["a", "b'", "c"]);
    expect(rematch).toHaveBeenCalledTimes(1);
  });

  it("drops what neither path can find", () => {
    const out = remapSelection(memos("a", "b"), (m) => (m.tag === "a" ? m.tag : null), () => null);
    expect(out).toEqual(["a"]);
  });

  it("collapses two memos that resolve to the same entity", () => {
    // A fillet can merge two selected collinear stretches into one rebuilt
    // edge. Handing the same entity to a TOGGLE twice would select it and then
    // immediately deselect it, the selection would vanish for no visible
    // reason, which is the exact failure this whole file exists to prevent.
    const out = remapSelection(memos("a", "b"), () => null, () => "merged");
    expect(out).toEqual(["merged"]);
  });

  it("treats a zero entity as real, not as absent", () => {
    // faceIds start at 0. A truthiness test here silently drops the first face
    // of the first body, a bug that would look like "sometimes it works".
    const out = remapSelection(memos("a"), () => 0, () => null);
    expect(out).toEqual([0]);
  });

  it("abandons the fallback entirely once too many entities need it", () => {
    const many = memos(...Array.from({ length: MAX_GEOMETRIC_REMATCH + 1 }, (_, i) => `f${i}`));
    const rematch = vi.fn((m: Memo) => m.tag);
    const out = remapSelection(many, () => null, rematch);
    expect(out).toEqual([]);
    expect(rematch).not.toHaveBeenCalled();
  });

  it("still keeps survivors when the fallback is abandoned", () => {
    // Degrading to the pre-existing behaviour means losing what CANNOT be found
    // cheaply, not throwing away entities that are sitting right there.
    const many = memos(...Array.from({ length: MAX_GEOMETRIC_REMATCH + 2 }, (_, i) => `f${i}`));
    const out = remapSelection(many, (m) => (m.tag === "f0" ? m.tag : null), (m) => m.tag);
    expect(out).toEqual(["f0"]);
  });

  it("counts only the missing against the cap", () => {
    // A large selection is fine as long as most of it survived: the cap exists
    // to bound O(model) lookups, not to bound the selection size.
    const many = memos(...Array.from({ length: 200 }, (_, i) => `f${i}`));
    const out = remapSelection(many, (m) => (m.tag === "f7" ? null : m.tag), () => "found");
    expect(out).toHaveLength(200);
    expect(out[7]).toBe("found");
  });

  it("preserves capture order", () => {
    const out = remapSelection(
      memos("c", "a", "b"),
      (m) => (m.tag === "a" ? null : m.tag),
      (m) => m.tag,
    );
    expect(out).toEqual(["c", "a", "b"]);
  });

  it("does nothing with nothing", () => {
    expect(remapSelection([], () => "x", () => "y")).toEqual([]);
  });
});
