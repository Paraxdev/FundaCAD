import { describe, expect, it } from "vitest";
import { GuideSession } from "../../../src/ui/guide/guideSession";
import { emptySnapshot } from "../../../src/ui/guide/wait";

const session = () => new GuideSession(() => ({ found: true }), emptySnapshot);

describe("GuideSession steps", () => {
  it("keeps the keys an assistant gave a step, trimmed", () => {
    const g = session();
    g.apply([
      {
        kind: "highlight",
        seq: 1,
        target: { ui: "pick:fillet" },
        caption: "Open Fillet",
        keys: "  press Ctrl+K, type Fillet, press Enter ",
      },
    ]);
    expect(g.state.step).toMatchObject({ caption: "Open Fillet", keys: "press Ctrl+K, type Fillet, press Enter" });
  });

  it("shows a step from before keys existed, and one with blank keys or keys that are not text, without them", () => {
    const g = session();
    g.apply([{ kind: "highlight", seq: 1, target: { ui: "#browser" }, caption: "one", step: 1, of: 3 }]);
    expect(g.state.step).toMatchObject({ caption: "one", step: 1, of: 3, found: true });
    expect(g.state.step?.keys).toBeUndefined();
    for (const [seq, keys] of [
      [2, "   "],
      [3, 4],
    ] as const) {
      g.apply([{ kind: "highlight", seq, target: { ui: "#browser" }, caption: `step ${seq}`, keys }]);
      expect(g.state.step?.caption).toBe(`step ${seq}`);
      expect(g.state.step?.keys).toBeUndefined();
    }
  });
});
