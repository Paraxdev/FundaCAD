import { describe, expect, it, vi } from "vitest";
import type { EngineTools } from "../../src/app/engine";
import { runningTool } from "../../src/ui/runningTool";

const NAMES = ["extrude", "edgeFeature", "pressPull", "faceOffset", "draft", "thread", "textOnFace", "hole", "loft"];

function tools(active: string[]) {
  const t: Record<string, { active: boolean; cancel: ReturnType<typeof vi.fn> }> = {};
  for (const n of [...NAMES, "pattern", "mirror"]) t[n] = { active: active.includes(n), cancel: vi.fn() };
  return t;
}

describe("runningTool", () => {
  it("is null while no tool runs", () => {
    expect(runningTool(tools([]) as unknown as EngineTools)).toBeNull();
  });

  it("names Mirror while it runs and its cancel stands the Mirror tool down", () => {
    const t = tools(["mirror"]);
    const r = runningTool(t as unknown as EngineTools);
    expect(r && { label: r.label, icon: r.icon, action: r.action }).toEqual({
      label: "Mirror",
      icon: "mirror",
      action: "mirror",
    });
    r!.cancel();
    expect(t.mirror!.cancel).toHaveBeenCalledTimes(1);
    expect(t.pattern!.cancel).not.toHaveBeenCalled();
  });

  it("puts a running pattern ahead of Mirror", () => {
    const t = tools(["pattern", "mirror"]);
    const r = runningTool(t as unknown as EngineTools);
    expect(r?.action).toBe("pattern-linear");
    r!.cancel();
    expect(t.pattern!.cancel).toHaveBeenCalledTimes(1);
    expect(t.mirror!.cancel).not.toHaveBeenCalled();
  });
});
