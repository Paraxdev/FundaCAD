// What cleans the native tracer's cap, and the optional one-time download of
// Open Image Denoise. One state for the panel and Preferences, so both show
// the same answer while a download runs.

import { reactive } from "vue";

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
  return `about ${Math.round(bytes / 1e6)} MB`;
}

/** The line under the Denoise row: which denoiser is active and why. */
export function describeDenoiser(s: { info: DenoiserInfo | null; downloading: boolean; error: string }): string {
  if (s.downloading) return "Downloading Open Image Denoise…";
  if (!s.info) return "";
  if (s.info.active === "oidn") return `Native tracer: Open Image Denoise ${s.info.version}.`;
  const why = s.error || (s.info.note && s.info.note !== "not downloaded" ? s.info.note : "");
  return `Native tracer: the edge aware filter${why ? `, ${why}` : ""}.`;
}
