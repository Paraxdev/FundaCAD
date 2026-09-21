// The MCP section of Preferences: a core setting, the status of the live
// session, and the setup for the bundled server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";

const tauri = vi.hoisted(() => ({
  server: "C:\\Program Files\\FundaCAD\\fundacad.exe" as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    if (cmd === "mcp_server") {
      if (tauri.server === null) throw "fundacad.exe is missing";
      return tauri.server;
    }
    throw new Error(`unexpected ${cmd}`);
  },
}));

import McpSection from "../../../src/components/overlays/McpSection.vue";
import { ENGINE } from "../../../src/app/engineKey";
import type { Engine } from "../../../src/app/engine";
import type { LiveState } from "../../../src/live/liveSession";
import { liveEditingMode, setLiveEditingMode } from "../../../src/ui/liveEditing";

enableAutoUnmount(afterEach);

function makeEngine(initial: LiveState) {
  let state = initial;
  const listeners = new Set<(s: LiveState) => void>();
  const live = {
    get snapshot() {
      return state;
    },
    subscribe(fn: (s: LiveState) => void) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    push(next: LiveState) {
      state = next;
      for (const fn of listeners) fn(state);
    },
  };
  return { live } as unknown as Engine & { live: typeof live };
}

async function mounted(engine?: Engine) {
  const w = mount(McpSection, engine ? { global: { provide: { [ENGINE as symbol]: engine } } } : {});
  await flushPromises();
  return w;
}

// The picker is now a Select (a button that opens a teleported popover), not a
// native <select>: open it, then click the option row by its label. The rows
// live under document.body because the popover teleports there.
async function pick(w: Awaited<ReturnType<typeof mounted>>, trigger: string, label: string) {
  await w.get(trigger).trigger("click");
  await flushPromises();
  const row = Array.from(document.body.querySelectorAll<HTMLElement>(".opt-row"))
    .find((r) => r.textContent?.trim() === label);
  if (!row) throw new Error(`no option "${label}" for ${trigger}`);
  row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await flushPromises();
}

const inTauri = (on: boolean) => {
  const g = globalThis as unknown as Record<string, unknown>;
  if (on) g.__TAURI_INTERNALS__ = {};
  else delete g.__TAURI_INTERNALS__;
};

beforeEach(() => {
  setActivePinia(createPinia());
  setLiveEditingMode("edit");
  tauri.server = "C:\\Program Files\\FundaCAD\\fundacad.exe";
  inTauri(true);
});
afterEach(() => {
  inTauri(false);
  localStorage.clear();
});

describe("sharing the live document", () => {
  it("is a core setting, there with no plugin installed, and it changes the mode", async () => {
    const w = await mounted();
    expect(w.get("#prefs-live").text()).toBe("Share, and allow edits");
    await pick(w, "#prefs-live", "Share, read only");
    expect(liveEditingMode()).toBe("read");
    await pick(w, "#prefs-live", "Do not share");
    expect(liveEditingMode()).toBe("off");
  });

  it("follows a change made elsewhere", async () => {
    const w = await mounted();
    setLiveEditingMode("off");
    await flushPromises();
    expect(w.get("#prefs-live").text()).toBe("Do not share");
  });
});

describe("the live session status", () => {
  it("says nothing is shared when sharing is off", async () => {
    setLiveEditingMode("off");
    const w = await mounted(makeEngine({ sharing: false, guests: [], lastEdit: null }));
    expect(w.get("#prefs-mcp-status").text()).toContain("Not shared");
  });

  it("says who is connected, and whether it can edit", async () => {
    const engine = makeEngine({ sharing: true, guests: [], lastEdit: null });
    const w = await mounted(engine);
    expect(w.get("#prefs-mcp-status").text()).toContain("no assistant is connected");

    engine.live.push({ sharing: true, guests: ["Claude Code"], lastEdit: null });
    await flushPromises();
    expect(w.get("#prefs-mcp-status").text()).toBe("Claude Code is connected and can edit.");

    setLiveEditingMode("read");
    await flushPromises();
    expect(w.get("#prefs-mcp-status").text()).toBe("Claude Code is connected, read only.");
  });
});

describe("how to connect it", () => {
  it("hands out the bundled MCP mode, per host, without installing anything", async () => {
    const w = await mounted();
    const server = "C:\\Program Files\\FundaCAD\\fundacad.exe";
    expect(w.get("#prefs-mcp-config").text()).toBe(`claude mcp add --scope user fundacad -- "${server}" --mcp`);

    await pick(w, "#prefs-mcp-host", "Claude Desktop");
    expect(JSON.parse(w.get("#prefs-mcp-config").text()).mcpServers.fundacad.command).toBe(server);

    await pick(w, "#prefs-mcp-host", "Another MCP host");
    expect(w.get("#prefs-mcp-config").text()).toBe(`"${server}" --mcp`);
  });

  it("copies what is shown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const w = await mounted();
    await w.get("#prefs-mcp-copy").trigger("click");
    expect(writeText).toHaveBeenCalledWith(w.get("#prefs-mcp-config").text());
  });

  it("says why when the app cannot name its executable", async () => {
    tauri.server = null;
    const w = await mounted();
    expect(w.find("#prefs-mcp-config").exists()).toBe(false);
    expect(w.get("#prefs-mcp-unavailable").text()).toContain("fundacad.exe is missing");
  });
});
