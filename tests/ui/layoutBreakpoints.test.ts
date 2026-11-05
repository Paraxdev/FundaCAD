import { describe, expect, it } from "vitest";
import responsive from "../../src/styles/_responsive.scss?raw";
import { isTitleBarFolded, TITLEBAR_FOLD_PX, TITLEBAR_FOLD_QUERY } from "../../src/ui/layoutBreakpoints";

describe("the title bar fold", () => {
  it("folds at and under TITLEBAR_FOLD_PX, as max-width does", () => {
    expect(isTitleBarFolded(TITLEBAR_FOLD_PX)).toBe(true);
    expect(isTitleBarFolded(390)).toBe(true);
    expect(isTitleBarFolded(TITLEBAR_FOLD_PX + 1)).toBe(false);
    expect(isTitleBarFolded(0)).toBe(false);
    expect(TITLEBAR_FOLD_QUERY).toBe(`(max-width: ${TITLEBAR_FOLD_PX}px)`);
  });

  // tauri.conf.json: the window opens at 1280 by 800 and goes no smaller than 800 by 600.
  it("folds the smallest window at 200 percent and keeps the default window whole", () => {
    expect(isTitleBarFolded(800 / 2)).toBe(true);
    expect(isTitleBarFolded(1280 / 2)).toBe(false);
    expect(isTitleBarFolded(800)).toBe(false);
  });

  it("has a CSS half that hides what the File menu takes over", () => {
    const block = responsive.split(`@media ${TITLEBAR_FOLD_QUERY} {`)[1]?.split("\n}")[0] ?? "";
    expect(block).toContain("#titlebar .docname");
    expect(block).toContain("#titlebar #workspace-toggle");
  });
});
