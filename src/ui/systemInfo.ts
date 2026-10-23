export interface SystemInfo {
  system: string;
  webview: string | null;
}

function platformLine(): SystemInfo {
  return { system: globalThis.navigator?.platform || "unknown", webview: null };
}

export async function systemInfo(): Promise<SystemInfo> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return platformLine();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const info = await invoke<Partial<SystemInfo> | null>("system_info");
    if (typeof info?.system !== "string") return platformLine();
    return { system: info.system, webview: typeof info.webview === "string" ? info.webview : null };
  } catch {
    return platformLine();
  }
}
