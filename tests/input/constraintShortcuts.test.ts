// Every constraint tool has a sketch key, the ? sheet lists it, and no two
// rows of one context share a key.
import { describe, it, expect } from "vitest";
import { SHORTCUTS, formatShortcut, resolveShortcut, shortcutHudGroups } from "../../src/input/shortcuts";
import { CONSTRAINT_TOOLS } from "../../src/sketch/constraintTools";
import { SKETCH_MODIFY } from "../../src/app/actionTables";

const constraintActions = Object.entries(SKETCH_MODIFY)
  .filter(([, tool]) => CONSTRAINT_TOOLS.has(tool))
  .map(([a]) => a);

describe("constraint shortcuts", () => {
  it("covers every constraint tool", () => {
    expect(constraintActions).toHaveLength(CONSTRAINT_TOOLS.size);
    for (const a of constraintActions) {
      const row = SHORTCUTS.find((s) => s.action === a && s.context === "sketch");
      expect(row, a).toBeDefined();
      expect(resolveShortcut(row!.key, !!row!.shift, "sketch")).toBe(a);
    }
  });

  it("are listed in the Sketch group of the ? sheet", () => {
    const sketch = shortcutHudGroups().find((g) => g.name === "Sketch")!;
    for (const a of constraintActions) {
      const row = SHORTCUTS.find((s) => s.action === a && s.context === "sketch")!;
      expect(sketch.rows).toContainEqual({ key: formatShortcut(row), label: row.label });
    }
  });

  it("no two rows of one context, or a context and global, share a key", () => {
    const seen = new Map<string, string>();
    for (const s of SHORTCUTS) {
      const contexts = s.context === "global" ? ["model", "sketch"] : [s.context];
      for (const c of contexts) {
        const k = `${c}:${s.ctrl ? "C" : ""}${s.shift ? "S" : ""}${s.key}`;
        expect(seen.get(k), `${k} is ${seen.get(k)} and ${s.action}`).toBeUndefined();
        seen.set(k, s.action);
      }
    }
  });
});
