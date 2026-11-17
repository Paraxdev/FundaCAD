export interface SystemInfo {
  system: string;
  webview: string | null;
  /** Linux only: whether a screen reader can find the app, and what in the environment turns that off. */
  accessibility: string | null;
}

function platformLine(): SystemInfo {
  return { system: globalThis.navigator?.platform || "unknown", webview: null, accessibility: null };
}

const text = (v: unknown) => (typeof v === "string" ? v : null);

export async function systemInfo(): Promise<SystemInfo> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return platformLine();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<Partial<SystemInfo> | null>("system_info");
    if (typeof info?.system !== "string") return platformLine();
    return { system: info.system, webview: text(info.webview), accessibility: text(info.accessibility) };
  } catch {
    return platformLine();
  }
}
