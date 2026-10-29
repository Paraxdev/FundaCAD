# Connect an AI assistant

FundaCAD has a built-in server that lets an AI assistant build and check parts with the same engine as the app. It works with any assistant that supports MCP.

<!-- shot: prefs-ai-assistants | AI assistants page with the Copy button -->

1. Open Edit, Preferences (Ctrl+,) and choose AI assistants.
2. Under How to connect it, pick your assistant in Assistant.
3. Press Copy. The text has your real path filled in.
4. Use the text in your assistant:
    - **Claude Code**: run the `claude mcp add` command in a terminal, then start a new session.
    - **Claude Desktop**: add the block to `claude_desktop_config.json` through Settings, Developer, Edit Config, then restart it.
    - **Another MCP host**: start the program with `--mcp`, or give it the same block Claude Desktop takes.

## Where it may open and save files

The assistant can open, import, save and export files in any of your folders. It never reads or writes:

- in hidden folders, whose names start with a dot, such as `.ssh`
- directly in your home folder
- at the root of a drive

To keep it to some folders only, add `--allow-path` and a folder after `--mcp` in the copied text, once per folder. For example `--mcp --allow-path D:/parts`.

It then works only in those folders, the folder of your open document and the app's own folders. When it is refused a file, it says why and which folder would let it through.
