// The MCP switch in Preferences. The shell keeps it, since the engine worker reads it when it starts, before this page
// loads. Off, the worker opens no live session port, so this window shares nothing either.

const inShell = () => "__TAURI_INTERNALS__" in globalThis;

let enabled: boolean | null = null;
const listeners = new Set<() => void>();

function changed(on: boolean) {
  if (enabled === on) return;
  enabled = on;
  for (const fn of listeners) fn();
}

/** Null until the shell has said, so nothing is shared on a guess. A plain browser has no port to close, so it is on. */
export function mcpEnabled(): boolean | null {
  return inShell() ? enabled : true;
}

/** Whether this window has the switch at all, which only the desktop app does. */
export function mcpSwitchShown(): boolean {
  return inShell();
}

/** An app that cannot say counts as on, the shell's own default. */
export async function loadMcpSwitch(): Promise<void> {
  if (!inShell()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    changed((await invoke<boolean>("mcp_enabled")) !== false);
  } catch {
    changed(true);
  }
}

/** Saved first and applied after, so a failure leaves the switch as it was and throws for the caller to say so. */
export async function setMcpEnabled(on: boolean): Promise<void> {
  if (!inShell()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("mcp_set_enabled", { enabled: on });
  changed(on);
}

export function onMcpChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
