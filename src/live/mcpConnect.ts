// The command line an MCP host (Claude Code, Claude Desktop, an editor) uses to start this executable's MCP server.
// It needs no arguments: its engine is the app with `--engine --ws`, and it finds a running window via session.json.

import { t } from "../i18n";

export type McpHost = "claude-code" | "claude-desktop" | "other";

export const MCP_HOSTS: readonly { readonly id: McpHost; readonly label: string }[] = [
  {
    id: "claude-code",
    get label() {
      return t("prefs.mcp.host.claudeCode");
    },
  },
  {
    id: "claude-desktop",
    get label() {
      return t("prefs.mcp.host.claudeDesktop");
    },
  },
  {
    id: "other",
    get label() {
      return t("prefs.mcp.host.other");
    },
  },
];

export function asMcpHost(v: unknown): McpHost | null {
  return MCP_HOSTS.some((h) => h.id === v) ? (v as McpHost) : null;
}

export interface LaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function mcpServerLaunch(server: string): LaunchConfig {
  return { command: server, args: ["--mcp"], env: {} };
}

/** The `mcpServers` block Claude Desktop and most hosts read from a config file. */
export function mcpConfigBlock(launch: LaunchConfig): string {
  return JSON.stringify({ mcpServers: { fundacad: launch } }, null, 2);
}

/** A Windows path goes in double quotes untouched, its backslashes are literal to
 *  PowerShell and cmd and a Windows file name cannot hold a double quote. A POSIX
 *  path goes in single quotes, where only the quote itself needs rewriting. */
function quoted(path: string): string {
  if (/^[A-Za-z]:|\\/.test(path)) return `"${path}"`;
  return `'${path.replace(/'/g, `'\\''`)}'`;
}

/** What to paste for one host, and where it goes. */
export function mcpSetupFor(host: McpHost, server: string): { text: string; hint: string } {
  switch (host) {
    case "claude-code":
      return {
        text: `claude mcp add --scope user fundacad -- ${quoted(server)} --mcp`,
        hint: t("prefs.mcp.hint.claudeCode"),
      };
    case "claude-desktop":
      return {
        text: mcpConfigBlock(mcpServerLaunch(server)),
        hint: t("prefs.mcp.hint.claudeDesktop"),
      };
    case "other":
      return {
        text: `${quoted(server)} --mcp`,
        hint: t("prefs.mcp.hint.other"),
      };
  }
}

/** This executable's path. Throws with a sentence a person can read in a plain
 *  browser session. */
export async function mcpServerPath(): Promise<string> {
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    throw new Error(t("prefs.mcp.notDesktop"));
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string>("mcp_server");
}
