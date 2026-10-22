import { describe, it, expect } from "vitest";
import { sketchToolKey } from "../../src/sketch/toolKeys";
import { SHORTCUTS } from "../../src/input/shortcuts";

const press = (
  key: string,
  mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {},
) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("sketchToolKey", () => {
  it("arms the drawing tools on bare letters", () => {
    expect(sketchToolKey(press("l"), "select")).toBe("line");
    expect(sketchToolKey(press("C"), "select")).toBe("circle");
    expect(sketchToolKey(press("p"), "select")).toBe("project");
    expect(sketchToolKey(press("a"), "arc")).toBe("tangent-arc");
  });

  it("leaves every sketch constraint shortcut with a modifier to the keymap", () => {
    // SketchMode listens in the capture phase, so a letter it claims here never
    // reaches the keymap: Shift+P armed Project and cleared the selection.
    const held = SHORTCUTS.filter((s) => s.context === "sketch" && (s.shift || s.ctrl));
    expect(held.length).toBeGreaterThan(0);
    for (const s of held) {
      const e = press(s.shift ? s.key.toUpperCase() : s.key, { shiftKey: !!s.shift, ctrlKey: !!s.ctrl });
      expect(sketchToolKey(e, "select"), `${s.shift ? "Shift+" : "Ctrl+"}${s.key}`).toBeNull();
    }
  });
});
