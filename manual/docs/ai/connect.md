# Connecting an AI assistant

FundaCAD has a built-in server that lets an AI assistant build and inspect parts with the same engine the app uses. You describe a part in plain words, the assistant adds sketches and steps, checks the result, and saves a file you can open and keep editing.

There is nothing to install. The server comes with FundaCAD, and you only have to tell your assistant where to find it. It works with any assistant that supports the Model Context Protocol, MCP for short. Claude Code and Claude Desktop are covered below.

## Getting connected

Open Edit, Preferences (Ctrl+,) and choose AI assistants. Under How to connect it, the Assistant list picks the program you use. The page then shows the exact text for your computer, with the real path to FundaCAD already filled in, and a Copy button.

<!-- shot: prefs-ai-assistants | Preferences on the AI assistants page with the Assistant list and the setup text with its Copy button -->

For Claude Code, the text is a single command that starts with `claude mcp add`. Paste it into a terminal, then start a new Claude Code session so it picks the server up.

For Claude Desktop, the text is a small block of settings. Add it to the file `claude_desktop_config.json`, which you reach through Settings, Developer, Edit Config in Claude Desktop, and then restart Claude Desktop.

For Another MCP host, the page gives you the program to start, which is FundaCAD run with `--mcp`. Programs that read an `mcpServers` block in their settings take the same block that Claude Desktop does.

## Sharing your open document

The Live document setting on the same page decides what an assistant may do with the document you have open.

Share, and allow edits is the default, and it lets the assistant change your open document, so you can watch the part grow while you talk. Each change the assistant makes is one step you can undo with Ctrl+Z, the same as a change of your own. If you change something yourself while the assistant is thinking, it cannot overwrite your change, because its edits are checked against the version of the document it saw.

Share, read only lets the assistant look at your document and measure it, and anything it tries to change is refused. Pick it if you would rather do the editing yourself. Do not share means the assistant works on a copy of its own and your open document is untouched.

The title bar shows who is connected, and the Status line on the page says the same in a sentence.

## What the assistant can do

An assistant can create or open a document, set parameters, and add, change, move or remove steps. It can rebuild and tell you what came out and what failed, measure volume, area and size, and take pictures of the model from any side, sections included.

It can also run the checks you can: interference between bodies, a stress study of a body, and a printability check. And it can read in a STEP, STL, 3MF or OBJ file to model against, and export the result.

## Getting good results

Give the assistant real dimensions, or a file of the thing the part has to fit. A mount for a real motor comes out much better when the assistant can read the motor's STEP file than when it guesses.

Tell it which way the part sits. Z is up in FundaCAD, so a sketch on the XY plane is a floor plan and a sketch on XZ is a side view.

Ask it to put the important dimensions into named parameters and to save a `.funda` file when it is done. Then you can open the file and change a number yourself, without asking again.
