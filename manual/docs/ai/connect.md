# Connect an AI assistant

FundaCAD has a built-in server that lets an AI assistant build and check parts with the same engine as the app. It works with any assistant that supports MCP.

<!-- shot: prefs-ai-assistants | AI assistants page with the Copy button -->

Open Edit, Preferences (Ctrl+,) and choose AI assistants. Pick your assistant under How to connect it, and copy the text shown, which has your real path filled in.

For Claude Code it is one `claude mcp add` command, then start a new session. For Claude Desktop, add the block to `claude_desktop_config.json` through Settings, Developer, Edit Config, and restart.

## Where it may open and save files

The assistant can open, import, save and export files in any of your folders. It never reads or writes in hidden folders (names that start with a dot, such as `.ssh`), directly in your home folder or at the root of a drive, so save in a folder inside them.

To keep it to some folders only, add `--allow-path` and a folder after `--mcp` in the copied text, once per folder, for example `--mcp --allow-path D:/parts`. It then works only in those folders, the folder of the document you have open, and the app's own folders. When it is refused a file, it says why and which folder would let it through.
