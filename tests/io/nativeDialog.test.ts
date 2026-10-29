import { describe, expect, it, vi } from "vitest";

const save = vi.fn(async (_o?: unknown) => "C:/parts/bracket.funda");
vi.mock("@tauri-apps/plugin-dialog", () => ({ save }));

import { nativeDialog } from "../../src/io/nativeDialog";

describe("nativeDialog without a DOM", () => {
  it("passes the call through when there is no document to hand focus back to", async () => {
    expect(typeof document).toBe("undefined");
    const { save: wrapped } = await nativeDialog();
    await expect(wrapped({ defaultPath: "bracket" })).resolves.toBe("C:/parts/bracket.funda");
    expect(save).toHaveBeenCalledWith({ defaultPath: "bracket" });
  });

  it("loads against a mock that defines only some of the plugin", async () => {
    const d = await nativeDialog();
    expect(typeof d.open).toBe("function");
    expect(typeof d.message).toBe("function");
  });
});
