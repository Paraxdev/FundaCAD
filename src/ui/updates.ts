// In-app updates via tauri-plugin-updater from the rolling release's latest.json. The Rust `updates_supported` command
// gates out deb, rpm, Flatpak and browser dev, where the updater cannot replace the install.

import { choose } from "./choice";
import { toast } from "./toast";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** false outside Tauri, and on Linux unless running as an AppImage */
async function updatesSupported(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("updates_supported");
  } catch {
    return false;
  }
}

/** the packaged app's version ("dev" in a plain-browser session). CI stamps
 *  packaged beta builds 1.0.<run>; local builds carry tauri.conf.json's 1.0.0. */
export async function appVersion(): Promise<string> {
  if (!isTauri()) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
}

/** Help → About: the one place to read off which version is running. */
export async function showAbout(): Promise<void> {
  const { listModal } = await import("./choice");
  await listModal("About FundaCAD", [`Version ${await appVersion()}`]);
}

/** Check this build's feed and prompt to install when an update exists. An available
 *  update always prompts; `interactive` additionally surfaces "up to date",
 *  "not applicable here", and failures (the quiet startup check stays silent). */
export async function checkForUpdates(interactive: boolean): Promise<void> {
  if (!(await updatesSupported())) {
    if (interactive)
      toast("This install does not update itself. Install the newer file from the releases page over it.", {
        timeout: 8000,
      });
    return;
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (interactive) toast(`FundaCAD ${await appVersion()} is up to date.`);
      return;
    }
    const pick = await choose(`Update ${update.version} is available`, [
      { value: "install", label: "Restart & update" },
      { value: "later", label: "Later" },
    ]);
    if (pick !== "install") return;
    toast("Downloading the update…");
    await update.downloadAndInstall();
    // Not the process plugin's relaunch(): it keeps the single-instance lock, so the new process can find it held and
    // quit. This command drops the lock first (restart_for_update in src-tauri/src/lib.rs).
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("restart_for_update");
  } catch (err) {
    console.error("[updates] check/install failed:", err);
    if (interactive) {
      // Most often a build published without a signing key has no latest.json, a 404 that reads as a network fault, so
      // the message says what to do instead of guessing from the error text.
      const why = err instanceof Error ? err.message : String(err);
      toast(`Could not check for updates. Download the newest build from the releases page. (${why})`, {
        kind: "error",
      });
    }
  }
}

/** Quiet startup check. Packaged builds only: dev builds carry version 0.1.0,
 *  which is always older than the rolling feed and would prompt on every run. */
export function scheduleStartupUpdateCheck(): void {
  if (import.meta.env.DEV) return;
  setTimeout(() => void checkForUpdates(false), 8000);
}
