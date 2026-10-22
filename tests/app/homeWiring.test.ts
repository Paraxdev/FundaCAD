import { describe, expect, it, vi } from "vitest";
import { wireHomeOnOpen } from "../../src/app/homeWiring";
import { setSaveFolder, suggestedSavePath } from "../../src/io/saveFolder";

describe("an open", () => {
  it("closes Home and clears the Save As folder hint", () => {
    let fire = () => {};
    const store = {
      onOpen: (cb: () => void) => {
        fire = cb;
        return () => {};
      },
    };
    const home = { close: vi.fn() };
    wireHomeOnOpen(store, home);
    setSaveFolder("D:/projects/brackets");
    expect(suggestedSavePath(null, "Untitled.funda")).toBe("D:/projects/brackets/Untitled.funda");
    fire();
    expect(home.close).toHaveBeenCalledOnce();
    expect(suggestedSavePath(null, "Untitled.funda")).toBe("Untitled.funda");
  });
});
