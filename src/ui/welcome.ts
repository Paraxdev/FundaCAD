// Welcome screen: opens at startup (unless turned off) and from the Help menu.
//
// Facade over stores/dialogs.ts, rendered by
// components/overlays/WelcomeModal.vue.
//
// It used to embed a remote page in an iframe, which made the welcome screen
// the one piece of remote content the webview loaded and the app's startup
// dependent on someone else's server being up. It is local-only now: New, Open,
// and the recent files.

import { useDialogStore } from "../stores/dialogs";
import type { OpenOutcome } from "../io/files";
import { readSetting } from "./storedSetting";

const SHOW_KEY = "fundacad.welcomeOnStartup";
const LEGACY_SHOW_KEYS = ["neocad.welcomeOnStartup", "sindri.welcomeOnStartup"];
export function welcomeOnStartup(): boolean {
  return readSetting(SHOW_KEY, ...LEGACY_SHOW_KEYS) !== "false";
}

/** The footer checkbox. Split out so the component writes the same key rather
 *  than knowing the key's name. */
export function setWelcomeOnStartup(on: boolean): void {
  localStorage.setItem(SHOW_KEY, on ? "true" : "false");
}

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

export interface WelcomeCallbacks {
  onNew: () => void;
  onOpen: () => void;
  onOpenPath: (path: string) => Promise<OpenOutcome>;
}

/** Kept as a class so app/engine.ts's construction site and the two `.open()`
 *  call sites are untouched. It is now three lines of store access. */
export class WelcomeScreen {
  constructor(cb: WelcomeCallbacks) {
    useDialogStore().bindWelcome(cb);
  }

  open(): void {
    useDialogStore().welcome = true;
  }

  close(): void {
    useDialogStore().welcome = false;
  }
}
