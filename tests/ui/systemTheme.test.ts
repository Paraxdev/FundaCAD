import { afterEach, describe, expect, it, vi } from "vitest";

type Os = { light: boolean; contrast: boolean; forced: boolean };

function fakeMedia(start: Partial<Os>) {
  const os: Os = { light: false, contrast: false, forced: false, ...start };
  const listeners = new Set<() => void>();
  const evaluate = (q: string) =>
    (q === "(prefers-color-scheme: light)" && os.light) ||
    (q === "(prefers-contrast: more)" && os.contrast) ||
    (q === "(forced-colors: active)" && os.forced);
  const matchMedia = (q: string) => ({
    media: q,
    get matches() {
      return evaluate(q);
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  });
  return {
    matchMedia,
    change(next: Partial<Os>) {
      Object.assign(os, next);
      for (const fn of listeners) fn();
    },
  };
}

function fakeStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  };
}

async function boot(os: Partial<Os> | null, stored: Record<string, string> = {}) {
  vi.resetModules();
  const media = fakeMedia(os ?? {});
  if (os) vi.stubGlobal("matchMedia", media.matchMedia);
  const storage = fakeStorage(stored);
  vi.stubGlobal("localStorage", storage);
  const theme = await import("../../src/ui/theme");
  theme.initTheme();
  const changes = vi.fn();
  theme.onThemeChange(changes);
  return { theme, media, storage, changes };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("@tauri-apps/api/window");
  vi.doUnmock("@tauri-apps/api/core");
});

type WindowHandlers = {
  theme?: (e: { payload: string }) => void;
  focus?: (e: { payload: boolean }) => void;
};

function tauriWindow(theme: string): WindowHandlers {
  const handlers: WindowHandlers = {};
  vi.doMock("@tauri-apps/api/window", () => ({
    getCurrentWindow: () => ({
      theme: async () => theme,
      onThemeChanged: async (fn: NonNullable<WindowHandlers["theme"]>) => {
        handlers.theme = fn;
        return () => {};
      },
      onFocusChanged: async (fn: NonNullable<WindowHandlers["focus"]>) => {
        handlers.focus = fn;
        return () => {};
      },
    }),
  }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  return handlers;
}

describe("systemThemeFor", () => {
  it("maps dark, light and contrast from the OS to a shipped palette", async () => {
    const { theme } = await boot({});
    expect(theme.systemThemeFor({ dark: true, contrast: false })).toBe("fundacad");
    expect(theme.systemThemeFor({ dark: false, contrast: false })).toBe("fundacad-light");
    expect(theme.systemThemeFor({ dark: true, contrast: true })).toBe("high-contrast-dark");
    expect(theme.systemThemeFor({ dark: false, contrast: true })).toBe("high-contrast-light");
  });
});

describe("the System theme on first run", () => {
  it("is the choice when nothing is stored, and writes nothing", async () => {
    const { theme, storage } = await boot({ light: true });
    expect(theme.DEFAULT_THEME_ID).toBe("system");
    expect(theme.getTheme()).toBe("system");
    expect(theme.resolvedTheme()).toBe("fundacad-light");
    expect(theme.themeMode()).toBe("light");
    expect(storage.data.has("fundacad.theme")).toBe(false);
  });

  it("gives Noir on a dark OS", async () => {
    const { theme } = await boot({});
    expect(theme.resolvedTheme()).toBe("fundacad");
    expect(theme.themeMode("system")).toBe("dark");
  });

  it("starts high contrast when the OS asks for more contrast or forces colours", async () => {
    expect((await boot({ light: true, contrast: true })).theme.resolvedTheme()).toBe("high-contrast-light");
    expect((await boot({ forced: true })).theme.resolvedTheme()).toBe("high-contrast-dark");
  });

  it("falls back to Noir when the webview reports nothing", async () => {
    const { theme } = await boot(null);
    expect(theme.resolvedTheme()).toBe("fundacad");
  });

  it("leads the roster, labelled System, grouped by the palette it resolves to", async () => {
    const { theme } = await boot({ light: true });
    expect(theme.themes()[0]).toStrictEqual({ id: "system", label: "System", mode: "light", custom: false });
    expect(theme.asThemeId("system")).toBe("system");
  });
});

describe("following the OS", () => {
  it("switches palette and tells the listeners when the OS appearance changes", async () => {
    const { theme, media, changes } = await boot({});
    media.change({ light: true });
    expect(theme.resolvedTheme()).toBe("fundacad-light");
    expect(theme.getTheme()).toBe("system");
    expect(changes).toHaveBeenCalledTimes(1);
    media.change({ contrast: true });
    expect(theme.resolvedTheme()).toBe("high-contrast-light");
    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("stays quiet when a change leaves the palette as it was", async () => {
    const { media, changes } = await boot({});
    media.change({ light: false });
    expect(changes).not.toHaveBeenCalled();
  });

  it("follows the Tauri window theme over the media query, and its changes", async () => {
    let handler: ((e: { payload: string }) => void) | null = null;
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => ({
        theme: async () => "light",
        onThemeChanged: async (fn: (e: { payload: string }) => void) => {
          handler = fn;
          return () => {};
        },
      }),
    }));
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    const { theme, changes } = await boot({});
    await vi.waitFor(() => expect(theme.resolvedTheme()).toBe("fundacad-light"));
    expect(changes).toHaveBeenCalledTimes(1);
    handler!({ payload: "dark" });
    expect(theme.resolvedTheme()).toBe("fundacad");
  });
});

describe("the Rust os_a11y_prefs fallback", () => {
  it("asks once in Tauri and turns a dark OS high contrast when it says so", async () => {
    const invoke = vi.fn(async () => ({ highContrast: true }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    tauriWindow("dark");
    const { theme } = await boot({});
    await vi.waitFor(() => expect(theme.resolvedTheme()).toBe("high-contrast-dark"));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("os_a11y_prefs");
  });

  it("never turns contrast off that the media query reports", async () => {
    const invoke = vi.fn(async () => ({ highContrast: false }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    tauriWindow("light");
    const { theme } = await boot({ contrast: true });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    await vi.waitFor(() => expect(theme.resolvedTheme()).toBe("high-contrast-light"));
  });

  it("asks again when the window regains focus, so contrast switched off while running is followed", async () => {
    let highContrast = true;
    const invoke = vi.fn(async () => ({ highContrast }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const win = tauriWindow("dark");
    const { theme } = await boot({});
    await vi.waitFor(() => expect(theme.resolvedTheme()).toBe("high-contrast-dark"));
    await vi.waitFor(() => expect(win.focus).toBeDefined());
    highContrast = false;
    win.focus!({ payload: false });
    win.focus!({ payload: true });
    await vi.waitFor(() => expect(theme.resolvedTheme()).toBe("fundacad"));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keeps the last answer when a later lookup gets none, as a hung gsettings gives null", async () => {
    let highContrast: boolean | null = true;
    const invoke = vi.fn(async () => ({ highContrast }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const win = tauriWindow("dark");
    const { theme, changes } = await boot({});
    await vi.waitFor(() => expect(theme.resolvedTheme()).toBe("high-contrast-dark"));
    await vi.waitFor(() => expect(win.focus).toBeDefined());
    changes.mockClear();
    highContrast = null;
    win.focus!({ payload: true });
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    await invoke.mock.results[1]!.value;
    expect(theme.resolvedTheme()).toBe("high-contrast-dark");
    expect(changes).not.toHaveBeenCalled();
  });

  it("asks again when the window theme changes, as GNOME High Contrast swaps the GTK theme", async () => {
    let highContrast = false;
    const invoke = vi.fn(async () => ({ highContrast }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const win = tauriWindow("light");
    const { theme } = await boot({});
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(win.theme).toBeDefined());
    highContrast = true;
    win.theme!({ payload: "dark" });
    await vi.waitFor(() => expect(theme.resolvedTheme()).toBe("high-contrast-dark"));
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("leaves the media query answer when the command is missing", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("command os_a11y_prefs not found");
    });
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    tauriWindow("dark");
    const { theme } = await boot({});
    await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
    expect(theme.resolvedTheme()).toBe("fundacad");
  });

  it("is never asked outside Tauri", async () => {
    const invoke = vi.fn(async () => ({ highContrast: true }));
    vi.doMock("@tauri-apps/api/core", () => ({ invoke }));
    const { theme } = await boot({});
    await Promise.resolve();
    expect(invoke).not.toHaveBeenCalled();
    expect(theme.resolvedTheme()).toBe("fundacad");
  });
});

describe("a stored choice", () => {
  it("always wins over the OS and is never replaced", async () => {
    const { theme, media, storage, changes } = await boot(
      { light: true, contrast: true },
      { "fundacad.theme": "dracula" },
    );
    expect(theme.getTheme()).toBe("dracula");
    expect(theme.resolvedTheme()).toBe("dracula");
    media.change({ light: false, contrast: false });
    expect(theme.resolvedTheme()).toBe("dracula");
    expect(changes).not.toHaveBeenCalled();
    expect(storage.data.get("fundacad.theme")).toBe("dracula");
  });

  it("keeps a stored Noir on a light OS", async () => {
    const { theme } = await boot({ light: true }, { "fundacad.theme": "fundacad" });
    expect(theme.resolvedTheme()).toBe("fundacad");
  });

  it("follows the OS again once System is picked", async () => {
    const { theme, media, storage } = await boot({ light: true }, { "fundacad.theme": "dracula" });
    theme.setTheme("system");
    expect(theme.resolvedTheme()).toBe("fundacad-light");
    expect(storage.data.get("fundacad.theme")).toBe("system");
    media.change({ light: false });
    expect(theme.resolvedTheme()).toBe("fundacad");
  });

  it("falls back to System when the active upload is removed", async () => {
    const { theme } = await boot({ light: true });
    const res = theme.addCustomTheme({ label: "Temp", "--bg": "#123456" });
    if (!res.ok) throw new Error(res.error);
    theme.setTheme(res.theme.id);
    theme.removeCustomTheme(res.theme.id);
    expect(theme.getTheme()).toBe("system");
    expect(theme.resolvedTheme()).toBe("fundacad-light");
  });

  it("drops a stored upload that claims the System id", async () => {
    const library = JSON.stringify([{ id: "system", label: "Fake", "--bg": "#000000" }]);
    const { theme } = await boot({}, { "fundacad.themes": library });
    expect(theme.customThemes()).toEqual([]);
    expect(theme.themes().filter((t) => t.id === "system")).toHaveLength(1);
  });
});
