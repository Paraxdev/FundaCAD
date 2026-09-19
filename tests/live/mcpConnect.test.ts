// What an MCP host is handed to start FundaCAD's embedded MCP mode.

import { describe, expect, it } from "vitest";
import {
  asMcpHost,
  MCP_HOSTS,
  mcpConfigBlock,
  mcpServerLaunch,
  mcpServerPath,
  mcpSetupFor,
} from "../../src/live/mcpConnect";

const WIN = "C:\\Program Files\\FundaCAD\\fundacad.exe";
const MAC = "/Applications/FundaCAD.app/Contents/MacOS/fundacad";

describe("the command line an MCP host is given", () => {
  it("starts the bundled MCP mode", () => {
    const parsed = JSON.parse(mcpConfigBlock(mcpServerLaunch(WIN)));
    expect(parsed.mcpServers.fundacad).toEqual({ command: WIN, args: ["--mcp"], env: {} });
  });

  it("gives Claude Code a command with the path quoted, spaces and all", () => {
    const { text } = mcpSetupFor("claude-code", WIN);
    expect(text).toBe(`claude mcp add --scope user fundacad -- "${WIN}" --mcp`);
    expect(mcpSetupFor("claude-code", MAC).text).toBe(`claude mcp add --scope user fundacad -- "${MAC}" --mcp`);
  });

  it("gives Claude Desktop the block its config file takes", () => {
    const { text, hint } = mcpSetupFor("claude-desktop", WIN);
    expect(JSON.parse(text).mcpServers.fundacad.command).toBe(WIN);
    expect(hint).toContain("claude_desktop_config.json");
  });

  it("gives any other host the program to start", () => {
    const { text, hint } = mcpSetupFor("other", MAC);
    expect(text).toBe(`"${MAC}" --mcp`);
    expect(hint).toContain("stdio");
  });

  it("has an answer for every host it offers, and refuses one it does not", () => {
    for (const h of MCP_HOSTS) {
      expect(asMcpHost(h.id)).toBe(h.id);
      expect(mcpSetupFor(h.id, MAC).text).toContain(MAC);
    }
    expect(asMcpHost("cursor")).toBeNull();
    expect(asMcpHost(undefined)).toBeNull();
  });

  it("says why outside the desktop app rather than inventing a path", async () => {
    await expect(mcpServerPath()).rejects.toThrow(/desktop app/);
  });
});
