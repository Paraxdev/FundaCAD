// In-app updates via tauri-plugin-updater from the rolling release's latest.json. The Rust `updates_supported` command
// gates out deb, rpm, Flatpak and browser dev, where the updater cannot replace the install.

import { PRODUCT_NAME, sourceforgeUrl, versionLabel } from "../app/channel";
import { choose } from "./choice";
import { toast } from "./toast";
import { openExternal } from "./welcome";
import {
  autoUpdateCheck,
  lastUpdateCheck,
  onUpdatePrefsChange,
  PERIOD_MS,
  recordUpdateCheck,
  updatePeriod,
} from "./updatePrefs";

const isTauri = () => "__TAURI_INTERNALS__" in window;

/** false outside Tauri, and on Linux unless running as an AppImage */
export async function updatesSupported(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("updates_supported");
  } catch {
    return false;
  }
}

/** the packaged app's version ("dev" in a plain-browser session). CI stamps
 *  packaged builds 1.0.<run>, shown as dev-<run> on the development channel; local builds carry tauri.conf.json's
 *  1.0.0. */
export async function appVersion(): Promise<string> {
  if (!isTauri()) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return versionLabel(await getVersion());
  } catch {
    return "unknown";
  }
}

/** Help → About: the one place to read off which version is running. */
export async function showAbout(): Promise<void> {
  const { listModal } = await import("./choice");
  await listModal(`About ${PRODUCT_NAME}`, [`Version ${await appVersion()}`]);
}

/** "sketch": an open sketch holds edits Save cannot write; "stop": the user kept the unsaved work. */
export type BeforeInstall = () => Promise<"go" | "sketch" | "stop">;

const RESTART_LABEL = "Restart & update";

/** The returned action downloads once, so a press after a refusal goes straight to the checks. */
export function updateAction(
  update: { download(): Promise<void>; install(): Promise<void> },
  beforeInstall: BeforeInstall,
): () => Promise<void> {
  let downloaded: Promise<void> | null = null;
  const run = async (): Promise<void> => {
    try {
      if (!downloaded) {
        toast("Downloading the update…");
        downloaded = update.download();
      }
      await downloaded;
    } catch (err) {
      downloaded = null;
      return failed(err);
    }
    // After the download, when nothing more can change, and before the install, which on Windows may end the app.
    const verdict = await beforeInstall();
    if (verdict === "sketch") {
      toast(`Update not installed, finish the sketch first. ${RESTART_LABEL} installs it.`, {
        kind: "warning",
        timeout: 15000,
        action: { label: RESTART_LABEL, onClick: () => void run() },
      });
      return;
    }
    if (verdict === "stop") {
      toast("Update not installed. Help > Check for Updates… installs it later.", { kind: "warning" });
      return;
    }
    try {
      await update.install();
      // Not the process plugin's relaunch(): it keeps the single-instance lock, so the new process can find it held
      // and quit. This command drops the lock first (restart_for_update in src-tauri/src/lib.rs).
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("restart_for_update");
    } catch (err) {
      failed(err);
    }
  };
  return run;
}

const MIRROR_ACTION = {
  label: "Open SourceForge",
  onClick: () => void openExternal(sourceforgeUrl()),
};
const MIRROR_TEXT = "GitHub could not be reached. Download the newest build from SourceForge instead.";

function failed(err: unknown): void {
  console.error("[updates] install failed:", err);
  const why = err instanceof Error ? err.message : String(err);
  toast(`${MIRROR_TEXT} (${why})`, { kind: "error", action: MIRROR_ACTION });
}

/** `interactive` is Help's check: it asks with a modal and reports up to date, not applicable and failures. The
 *  automatic check offers a found update as a toast and is otherwise silent. Resolves true when the feed was reached. */
export async function checkForUpdates(interactive: boolean, beforeInstall: BeforeInstall): Promise<boolean> {
  if (!(await updatesSupported())) {
    if (interactive)
      toast(
        "This install does not update itself. Install the newer file from the GitHub releases page or the SourceForge mirror over it.",
        {
          timeout: 8000,
        },
      );
    return false;
  }
  let update;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    update = await check();
  } catch (err) {
    console.error("[updates] check failed:", err);
    if (interactive) {
      // Most often a build published without a signing key has no latest.json, a 404 that reads as a network fault,
      // so the message says what to do instead of guessing from the error text.
      const why = err instanceof Error ? err.message : String(err);
      toast(`${MIRROR_TEXT} (${why})`, { kind: "error", action: MIRROR_ACTION });
    }
    return false;
  }
  if (!update) {
    if (interactive) toast(`${PRODUCT_NAME} ${await appVersion()} is up to date.`);
    return true;
  }
  const run = updateAction(update, beforeInstall);
  if (!interactive) {
    toast(`${PRODUCT_NAME} ${versionLabel(update.version)} is available.`, {
      timeout: 30000,
      action: { label: RESTART_LABEL, onClick: () => void run() },
    });
    return true;
  }
  const pick = await choose(`Update ${versionLabel(update.version)} is available`, [
    { value: "install", label: RESTART_LABEL },
    { value: "later", label: "Later" },
  ]);
  if (pick === "install") await run();
  return true;
}

const LAUNCH_DELAY_MS = 8000;
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Packaged builds only: dev builds carry version 0.1.0, which is always older than the rolling feed. Checks once
 *  per period across launches, from one timer that every setting change replaces. */
export function scheduleStartupUpdateCheck(beforeInstall: BeforeInstall): void {
  if (import.meta.env.DEV) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  // A failure records nothing, so this session's own attempt is what spaces its retry.
  let attemptedAt: number | null = null;

  const nextDue = (): number => {
    if (updatePeriod() === "launch") return attemptedAt === null ? 0 : Infinity;
    const span = PERIOD_MS[updatePeriod()];
    const stored = lastUpdateCheck();
    const from = [stored, attemptedAt].filter((t): t is number => t !== null && t <= Date.now());
    return from.length ? Math.max(...from) + span : 0;
  };

  const plan = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!autoUpdateCheck() || running) return;
    const wait = nextDue() - Date.now();
    if (wait === Infinity) return;
    timer = setTimeout(fire, Math.min(MAX_TIMER_MS, wait > 0 ? wait : LAUNCH_DELAY_MS));
  };

  const fire = async () => {
    timer = undefined;
    if (!autoUpdateCheck() || nextDue() > Date.now()) return plan();
    running = true;
    attemptedAt = Date.now();
    try {
      if (await checkForUpdates(false, beforeInstall)) recordUpdateCheck(Date.now());
    } finally {
      running = false;
    }
    plan();
  };

  void updatesSupported().then((ok) => {
    if (!ok) return;
    onUpdatePrefsChange(plan);
    plan();
  });
}
