// What the OS says about appearance, for the System theme: dark or light, and whether the user asked for contrast.

export interface OsAppearance {
  dark: boolean;
  contrast: boolean;
}

const LIGHT = "(prefers-color-scheme: light)";
// WebView2 reports a Windows contrast theme as forced colours, WKWebView reports Increase contrast as more.
const CONTRAST = ["(prefers-contrast: more)", "(forced-colors: active)"];

/** The Tauri window theme, which WebKitGTK does not always pass on to prefers-color-scheme. */
let windowDark: boolean | null = null;
const listeners = new Set<() => void>();
let watching = false;

function matches(query: string): boolean {
  if (typeof matchMedia !== "function") return false;
  try {
    return matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** With nothing reported, dark: FundaCAD Noir was the only default before System. */
export function osAppearance(): OsAppearance {
  return {
    dark: windowDark ?? !matches(LIGHT),
    contrast: CONTRAST.some(matches),
  };
}

function changed() {
  for (const fn of listeners) fn();
}

function watchMedia(query: string) {
  try {
    const list = matchMedia(query);
    // WKWebView before Safari 14 (macOS 10.15) has only the older addListener on a MediaQueryList.
    if (typeof list.addEventListener === "function") list.addEventListener("change", changed);
    else list.addListener?.(changed);
  } catch {
    /* an engine without the query never reports a change to it */
  }
}

function setWindowTheme(theme: string | null) {
  const dark = theme === "dark" ? true : theme === "light" ? false : null;
  if (dark === windowDark) return;
  windowDark = dark;
  changed();
}

async function watchWindowTheme() {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    await win.onThemeChanged(({ payload }) => setWindowTheme(payload));
    setWindowTheme(await win.theme());
  } catch {
    /* the media query answer stands */
  }
}

/** Calls `fn` after the OS appearance changes. Listening starts with the first subscriber. */
export function onOsAppearanceChange(fn: () => void): () => void {
  listeners.add(fn);
  if (!watching) {
    watching = true;
    if (typeof matchMedia === "function") for (const q of [LIGHT, ...CONTRAST]) watchMedia(q);
    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) void watchWindowTheme();
  }
  return () => listeners.delete(fn);
}
