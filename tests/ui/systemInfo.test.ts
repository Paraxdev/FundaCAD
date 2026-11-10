import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (cmd: string) => invoke(cmd) }));

import { systemInfo } from "../../src/ui/systemInfo";

describe("the system facts", () => {
  beforeEach(() => {
    invoke.mockReset();
    vi.stubGlobal("navigator", { platform: "MacIntel" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("outside the app are the platform line and no webview, with nothing invoked", async () => {
    expect(await systemInfo()).toEqual({ system: "MacIntel", webview: null, accessibility: null });
    vi.stubGlobal("window", {});
    expect(await systemInfo()).toEqual({ system: "MacIntel", webview: null, accessibility: null });
    vi.stubGlobal("navigator", undefined);
    expect(await systemInfo()).toEqual({ system: "unknown", webview: null, accessibility: null });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("in the app come from the native command", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue({ system: "linux x86_64 · Fedora Linux 41 · Flatpak", webview: "WebKitGTK 2.46.3" });
    expect(await systemInfo()).toEqual({
      system: "linux x86_64 · Fedora Linux 41 · Flatpak",
      webview: "WebKitGTK 2.46.3",
      accessibility: null,
    });
    invoke.mockResolvedValue({
      system: "linux x86_64 · Arch Linux",
      webview: "WebKitGTK 2.48.1",
      accessibility: "AT-SPI bus up · NO_AT_BRIDGE=1 · wayland",
    });
    expect((await systemInfo()).accessibility).toBe("AT-SPI bus up · NO_AT_BRIDGE=1 · wayland");
    invoke.mockResolvedValue({ system: "windows x86_64", webview: null, accessibility: null });
    expect(await systemInfo()).toEqual({ system: "windows x86_64", webview: null, accessibility: null });
    expect(invoke.mock.calls).toEqual([["system_info"], ["system_info"], ["system_info"]]);
  });

  it("fall back to the platform line when the command fails or answers nonsense, and never throw", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockRejectedValue(new Error("command system_info not found"));
    expect(await systemInfo()).toEqual({ system: "MacIntel", webview: null, accessibility: null });
    invoke.mockResolvedValue("linux");
    expect(await systemInfo()).toEqual({ system: "MacIntel", webview: null, accessibility: null });
    invoke.mockResolvedValue({ system: "linux x86_64", webview: 7, accessibility: { bus: "up" } });
    expect(await systemInfo()).toEqual({ system: "linux x86_64", webview: null, accessibility: null });
  });
});
