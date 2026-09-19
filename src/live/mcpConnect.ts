// How an MCP host starts this executable's embedded MCP server.
//
// The app never runs the server, the host does (Claude Code, Claude Desktop, an
// editor), so what the app hands out is the command line in the shape each host
// takes. The server needs no arguments: its private engine is the app, started
// with `--engine --ws`, and it attaches to a running window by itself through
// session.json.


export type McpHost = "claude-code" | "claude-desktop" | "other";

export const MCP_HOSTS: readonly { id: McpHost; label: string }[] = [
  { id: "claude-code", label: "Claude Code" },
  { id: "claude-desktop", label: "Claude Desktop" },
  { id: "other", label: "Another MCP host" },
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

/** Double quotes survive PowerShell, cmd and POSIX shells alike for a path, and
 *  a Windows install path has a space in it more often than not. */
function quoted(path: string): string {
  return `"${path.replace(/"/g, '\\"')}"`;
}

/** What to paste for one host, and where it goes. */
export function mcpSetupFor(host: McpHost, server: string): { text: string; hint: string } {
  switch (host) {
    case "claude-code":
      return {
        text: `claude mcp add --scope user fundacad -- ${quoted(server)} --mcp`,
        hint: "Run this in a terminal, then start a new Claude Code session.",
      };
    case "claude-desktop":
      return {
        text: mcpConfigBlock(mcpServerLaunch(server)),
        hint:
          "Add this to claude_desktop_config.json (Settings, Developer, Edit Config), then restart Claude Desktop.",
      };
    case "other":
      return {
        text: `${quoted(server)} --mcp`,
        hint:
          "Start this program over stdio with --mcp. Hosts that read an mcpServers block take the same one Claude Desktop does.",
      };
  }
}

/** This executable's path. Throws with a sentence a person can read in a plain
 *  browser session. */
export async function mcpServerPath(): Promise<string> {
  if (!("__TAURI_INTERNALS__" in globalThis)) {
    throw new Error("MCP mode runs in the desktop app executable, not in a browser.");
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<string>("mcp_server");
}
