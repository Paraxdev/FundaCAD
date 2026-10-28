import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({ picked: "C:/parts/bracket.step" as string | null }));
// The native picker takes focus out of the webview, and WebKitGTK hands it back to the body.
vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    return host.picked;
  },
  save: async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    throw new Error("denied");
  },
  message: async () => {
    (document.activeElement as HTMLElement | null)?.blur();
  },
}));

import { nativeDialog } from "../../../src/io/nativeDialog";

const opener = () => document.querySelector<HTMLButtonElement>("#import")!;

beforeEach(() => {
  document.body.innerHTML = `<button id="import">Import</button><button id="other">Other</button>`;
  opener().focus();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("nativeDialog", () => {
  it("hands focus back to the control that opened the picker", async () => {
    const { open } = await nativeDialog();
    await expect(open({ multiple: false })).resolves.toBe("C:/parts/bracket.step");
    expect(document.activeElement).toBe(opener());
  });

  it("hands focus back when the save dialog fails", async () => {
    const { save } = await nativeDialog();
    await expect(save({})).rejects.toThrow("denied");
    expect(document.activeElement).toBe(opener());
  });

  it("hands focus back after a native message box", async () => {
    const { message } = await nativeDialog();
    await message("Could not open the file", { kind: "error" });
    expect(document.activeElement).toBe(opener());
  });
});
