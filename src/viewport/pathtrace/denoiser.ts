// One state for the panel and Preferences, so both show the same answer while a download runs.

import { reactive } from "vue";
import { t } from "../../i18n";

export interface DenoiserInfo {
  active: "oidn" | "filter";
  version: string;
  offered: boolean;
  bytes: number;
  note?: string | null;
}

export const denoiserState = reactive({
  info: null as DenoiserInfo | null,
  downloading: false,
  error: "",
});

type Call = (cmd: string) => Promise<unknown>;
const inApp = () => "__TAURI_INTERNALS__" in globalThis;
const tauri: Call = async (cmd) => (await import("@tauri-apps/api/core")).invoke(cmd);

/** Asks the app again; a set installed since loads without a restart. */
export async function refreshDenoiser(call: Call | null = inApp() ? tauri : null): Promise<void> {
  if (!call) return;
  try {
    denoiserState.info = (await call("pt_denoiser")) as DenoiserInfo;
  } catch (e) {
    denoiserState.error = String(e);
  }
}

export async function downloadDenoiser(call: Call | null = inApp() ? tauri : null): Promise<void> {
  if (!call || denoiserState.downloading) return;
  denoiserState.downloading = true;
  denoiserState.error = "";
  try {
    denoiserState.info = (await call("pt_denoiser_download")) as DenoiserInfo;
  } catch (e) {
    denoiserState.error = String(e);
  } finally {
    denoiserState.downloading = false;
  }
}

export function sizeLabel(bytes: number): string {
  return t("render.denoiser.size", { mb: Math.round(bytes / 1e6) });
}

// The app's own wording (src-tauri frames/denoiser.rs and tracer oidn.rs), read back to say it in the language.
const NOT_ON_MAC = "the high quality denoise is not offered on macOS yet, the edge aware filter cleans the picture";
const OFFLINE = /^the download failed, the edge aware filter stays \((.*)\)$/s;

function appNote(note: string): string {
  if (note === NOT_ON_MAC) return t("render.denoiser.notOnMac");
  const offline = OFFLINE.exec(note);
  return offline ? t("render.denoiser.offline", { detail: offline[1]! }) : note;
}

/** The line under the Denoise row: which denoiser is active and why. */
export function describeDenoiser(s: { info: DenoiserInfo | null; downloading: boolean; error: string }): string {
  if (s.downloading) return t("render.denoiser.downloading");
  if (!s.info) return "";
  if (s.info.active === "oidn") return t("render.denoiser.oidn", { version: s.info.version });
  const why = s.error || (s.info.note && s.info.note !== "not downloaded" ? s.info.note : "");
  return why ? t("render.denoiser.filterWhy", { why: appNote(why) }) : t("render.denoiser.filter");
}
