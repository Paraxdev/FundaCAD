// The theme names, the MCP host lines and the update notices read in the chosen language, with the version and
// channel placed where each language wants them.
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  toasts: [] as string[],
  titles: [] as string[],
  found: null as null | Record<string, unknown>,
}));
vi.mock("../../src/ui/toast", () => ({
  toast: (text: string) => {
    h.toasts.push(text);
  },
}));
vi.mock("../../src/ui/choice", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/ui/choice")>()),
  choose: async (title: string) => {
    h.titles.push(title);
    return null;
  },
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => (cmd === "update_check" ? { update: h.found, stable: true } : true),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class {
    version: string;
    currentVersion: string;
    constructor(meta: { version: string; currentVersion: string }) {
      this.version = meta.version;
      this.currentVersion = meta.currentVersion;
    }
  },
}));

import { setLanguage } from "../../src/i18n";
import { MCP_HOSTS, mcpServerPath, mcpSetupFor } from "../../src/live/mcpConnect";
import { addCustomTheme, BUILTIN_THEME, themes } from "../../src/ui/theme";
import { checkForUpdates } from "../../src/ui/updates";

afterEach(async () => {
  h.toasts.length = 0;
  h.titles.length = 0;
  h.found = null;
  delete (globalThis as Record<string, unknown>).window;
  await setLanguage("system");
});

describe("theme names", () => {
  it("follow the language on the same objects", async () => {
    const all = themes();
    expect(all.map((t) => t.label)).toContain("High Contrast Dark");
    expect(all[0]!.label).toBe("System");
    await setLanguage("de");
    expect(themes().map((t) => t.label)).toContain("Hoher Kontrast, dunkel");
    expect(BUILTIN_THEME.label).toBe("FundaCAD Noir");
    await setLanguage("ja");
    expect(themes()[0]!.label).toBe("システム");
    expect(themes().find((t) => t.id === "noir-blue")!.label).toBe("Noir ブルー");
  });

  it("refuse a bad upload in the language", async () => {
    await setLanguage("de");
    const res = addCustomTheme("nope");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("kein Design");
    const none = addCustomTheme({ nothing: 1 });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error).toContain('"--bg": "#141414"');
  });
});

describe("MCP host lines", () => {
  it("read in the language and keep the command", async () => {
    expect(MCP_HOSTS.map((x) => x.label)).toEqual(["Claude Code", "Claude Desktop", "Another MCP host"]);
    await setLanguage("de");
    expect(MCP_HOSTS[2]!.label).toBe("Ein anderer MCP-Host");
    const setup = mcpSetupFor("claude-code", "/usr/bin/fundacad");
    expect(setup.text).toBe("claude mcp add --scope user fundacad -- '/usr/bin/fundacad' --mcp");
    expect(setup.hint).toContain("Terminal");
    await setLanguage("ja");
    await expect(mcpServerPath()).rejects.toThrow("デスクトップアプリ");
  });
});

describe("update notices", () => {
  const meta = { version: "1.0.5", currentVersion: "1.0.9", downgrade: false };

  async function check(extra: Record<string, unknown> = {}, interactive = false) {
    (globalThis as Record<string, unknown>).window = { __TAURI_INTERNALS__: {} };
    h.found = { ...meta, ...extra };
    await checkForUpdates(interactive, async () => "go");
  }

  it("announce a found update in the language", async () => {
    await check();
    expect(h.toasts.at(-1)).toMatch(/^FundaCAD .*5 is available\.$/);
    await setLanguage("de");
    await check();
    expect(h.toasts.at(-1)).toMatch(/ist verfügbar\.$/);
    await setLanguage("ja");
    await check();
    expect(h.toasts.at(-1)).toMatch(/が利用できます。$/);
  });

  it("say a channel build is older, with the channel label as an argument", async () => {
    await setLanguage("de");
    await check({ downgrade: true });
    expect(h.toasts.at(-1)).toMatch(/ist verfügbar, aber älter als diese Version\.$/);
    await check({ downgrade: true }, true);
    expect(h.titles.at(-1)).toMatch(/ist älter als diese Version$/);
  });

  it("title the offer in the language", async () => {
    await setLanguage("ja");
    await check({}, true);
    expect(h.titles.at(-1)).toMatch(/^アップデート .* が利用できます$/);
    await setLanguage("de");
    await check({}, true);
    expect(h.titles.at(-1)).toMatch(/^Update .* ist verfügbar$/);
  });
});
