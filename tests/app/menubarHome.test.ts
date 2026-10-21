import { describe, expect, it, vi } from "vitest";
import { buildMenubar } from "../../src/app/menubarDef";
import { allCommands } from "../../src/ui/commands";
import type { Engine } from "../../src/app/engine";

describe("Home in the menus", () => {
  const open = vi.fn();
  const menus = buildMenubar({ ui: { home: { open } } } as unknown as Engine);
  const menu = (label: string) => menus.find((m) => m.label === label)!;

  it("is the first row of File", () => {
    const first = menu("File").items[0]!;
    expect(first.label).toBe("Home");
    first.onClick?.();
    expect(open).toHaveBeenCalledOnce();
  });

  it("left the Help menu", () => {
    expect(menu("Help").items.map((i) => i.label)).not.toContain("Home");
    expect(menu("Help").items.map((i) => i.label)).not.toContain("Welcome Screen");
  });

  it("keeps the welcome action id in the palette", () => {
    expect(allCommands().find((c) => c.id === "welcome")?.label).toBe("Home");
  });
});
