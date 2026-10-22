import { beforeEach, describe, expect, it, vi } from "vitest";

const choice = vi.hoisted(() => ({ pick: "discard" as string | null }));
vi.mock("../../src/ui/choice", () => ({ choose: vi.fn(async () => choice.pick) }));

import { newFromTemplate } from "../../src/app/documentActions";
import type { Engine } from "../../src/app/engine";

function fakeEngine(dirty = false) {
  const store = {
    dirty,
    load: vi.fn(),
    markOpenedWithoutPath: vi.fn(),
  };
  const frameNextModel = vi.fn();
  return { e: { store, sketch: { hasUncommittedEdits: false }, frameNextModel } as unknown as Engine, store };
}

describe("newFromTemplate", () => {
  beforeEach(() => {
    choice.pick = "discard";
  });

  it("loads the template as an untitled document named after it", async () => {
    const { e, store } = fakeEngine();
    await newFromTemplate(e, "plate");
    expect(JSON.parse(store.load.mock.calls[0]![0] as string).features.length).toBeGreaterThan(0);
    expect(store.markOpenedWithoutPath).toHaveBeenCalledWith("Plate");
    expect((e.frameNextModel as ReturnType<typeof vi.fn>).mock.calls).toEqual([[]]);
  });

  it("does nothing when the unsaved work is kept", async () => {
    choice.pick = "cancel";
    const { e, store } = fakeEngine(true);
    await newFromTemplate(e, "plate");
    expect(store.load).not.toHaveBeenCalled();
    expect(e.frameNextModel).not.toHaveBeenCalled();
  });
});
