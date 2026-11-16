// The MCP switch is kept by the shell, so this window shares nothing until the shell has said it may.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const shell = vi.hoisted(() => ({ on: true as boolean | Error, calls: [] as string[] }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { enabled: boolean }) => {
    shell.calls.push(cmd);
    if (shell.on instanceof Error) throw shell.on;
    if (cmd === "mcp_enabled") return shell.on;
    if (cmd === "mcp_set_enabled") shell.on = args!.enabled;
    return null;
  },
}));

import { loadMcpSwitch, mcpEnabled, mcpSwitchShown, onMcpChange, setMcpEnabled } from "../../src/live/mcpSwitch";

const g = globalThis as unknown as Record<string, unknown>;
const inShell = (on: boolean) => {
  if (on) g.__TAURI_INTERNALS__ = {};
  else delete g.__TAURI_INTERNALS__;
};

beforeEach(() => {
  shell.on = true;
  shell.calls = [];
  inShell(true);
});
afterEach(() => inShell(false));

describe("in the desktop app", () => {
  // First in the file, since nothing has asked the shell yet.
  it("is unknown until the shell answers, then follows it", async () => {
    shell.on = false;
    expect(mcpEnabled()).toBeNull();
    const heard = vi.fn();
    const stop = onMcpChange(heard);
    await loadMcpSwitch();
    stop();
    expect(mcpEnabled()).toBe(false);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("counts a shell that cannot say as on", async () => {
    shell.on = new Error("no such command");
    await loadMcpSwitch();
    expect(mcpEnabled()).toBe(true);
  });

  it("changes only once the shell has saved it", async () => {
    await setMcpEnabled(false);
    expect(mcpEnabled()).toBe(false);
    expect(shell.on).toBe(false);

    shell.on = new Error("Access is denied. (os error 5)");
    await expect(setMcpEnabled(true)).rejects.toThrow("Access is denied");
    expect(mcpEnabled()).toBe(false);
  });
});

describe("in a browser", () => {
  it("is on, offers no switch and asks no shell", async () => {
    inShell(false);
    expect(mcpEnabled()).toBe(true);
    expect(mcpSwitchShown()).toBe(false);
    await loadMcpSwitch();
    await setMcpEnabled(false);
    expect(mcpEnabled()).toBe(true);
    expect(shell.calls).toEqual([]);
  });
});
