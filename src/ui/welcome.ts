// The Home screen's startup switch and the system browser opener.

import { readSetting } from "./storedSetting";

const SHOW_KEY = "fundacad.welcomeOnStartup";
const LEGACY_SHOW_KEYS = ["neocad.welcomeOnStartup", "sindri.welcomeOnStartup"];
export function welcomeOnStartup(): boolean {
  return readSetting(SHOW_KEY, ...LEGACY_SHOW_KEYS) !== "false";
}

/** The footer checkbox. Split out so the component writes the same key rather
 *  than knowing the key's name. */
export function setWelcomeOnStartup(on: boolean): void {
  try {
    localStorage.setItem(SHOW_KEY, on ? "true" : "false");
  } catch {
    /* blocked storage keeps the default */
  }
}

const CLOSED_KEY = "fundacad.welcomeClosed";
export function welcomeClosed(): boolean {
  return readSetting(CLOSED_KEY) === "true";
}
export function closeWelcome(): void {
  try {
    localStorage.setItem(CLOSED_KEY, "true");
  } catch {
    /* blocked storage shows the welcome again next time */
  }
}

export const MANUAL_URL = "https://fundacad.dev/";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** Open a URL in the system browser (Tauri opener; new tab in plain dev). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } else {
    window.open(url, "_blank", "noopener");
  }
}
