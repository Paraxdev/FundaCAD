// The channel that carries a preview's refusal from the build to the box the
// user is typing in.
//
// rebuildBridge deliberately does NOT toast a preview's failures — a drag
// through an unbuildable range would emit one a frame — so before this existed
// the answer went nowhere the user was looking. The behaviour worth pinning is
// the de-duplication and the immediate replay: a drag settles on the same
// refusal many times, and a box that opens mid-failure has to show it without
// waiting for a build that may never be asked for.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { onPreviewError, previewError, setPreviewError } from "../../src/ui/previewError";

describe("previewError", () => {
  beforeEach(() => setPreviewError(null));

  it("carries a refusal to a listener", () => {
    const seen: (string | null)[] = [];
    const off = onPreviewError((m) => seen.push(m));
    setPreviewError("too tall");
    expect(seen).toEqual([null, "too tall"]);
    off();
  });

  it("replays the current state the moment a listener subscribes", () => {
    // The case that matters: a tool opens its box while a preview is ALREADY
    // being refused. Waiting for the next build would leave the box silent for
    // as long as the user leaves the value alone, which is exactly as long as
    // they are staring at it wondering why nothing happened.
    setPreviewError("too tall");
    const seen: (string | null)[] = [];
    const off = onPreviewError((m) => seen.push(m));
    expect(seen).toEqual(["too tall"]);
    off();
  });

  it("does not re-fire for the same refusal twice", () => {
    // A drag settles many times on one bad value. Without this the box would be
    // rewritten on every settle, and anything that animates off the change
    // would restart continuously.
    const fn = vi.fn();
    const off = onPreviewError(fn);
    fn.mockClear();
    setPreviewError("too tall");
    setPreviewError("too tall");
    expect(fn).toHaveBeenCalledTimes(1);
    off();
  });

  it("treats an empty or blank message as no refusal", () => {
    // A kernel that fails without a sentence must not light the box up with a
    // blank complaint: an empty red box says something is wrong and refuses to
    // say what, which is worse than the silence it replaced.
    setPreviewError("   ");
    expect(previewError()).toBeNull();
    setPreviewError("");
    expect(previewError()).toBeNull();
  });

  it("withdraws the refusal when the value becomes buildable", () => {
    const seen: (string | null)[] = [];
    setPreviewError("too tall");
    const off = onPreviewError((m) => seen.push(m));
    setPreviewError(null);
    expect(seen).toEqual(["too tall", null]);
    expect(previewError()).toBeNull();
    off();
  });

  it("stops calling a listener that unsubscribed", () => {
    const fn = vi.fn();
    onPreviewError(fn)();
    fn.mockClear();
    setPreviewError("too tall");
    expect(fn).not.toHaveBeenCalled();
  });
});
