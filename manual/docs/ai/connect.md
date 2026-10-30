# Connect an AI assistant

FundaCAD has a built-in server that lets an AI assistant build and check parts with the same engine as the app. It works with any assistant that supports MCP.

<!-- shot: prefs-ai-assistants | AI assistants page with the Copy button -->

1. Open Edit, Preferences (Ctrl+,) and choose AI assistants.
2. Under How to connect it, pick your assistant in Assistant.
3. Press Copy. The text has your real path filled in.
4. Use the text in your assistant:
    1. **Claude Code**: run the `claude mcp add` command in a terminal, then start a new session.
    2. **Claude Desktop**: add the block to `claude_desktop_config.json` through Settings, Developer, Edit Config, then restart it.
    3. **Another MCP host**: start the program with `--mcp`, or give it the same block Claude Desktop takes.

## Where it may open and save files

The assistant can open, import, save and export files in any of your folders. It never reads or writes:

1. in hidden folders, whose names start with a dot, such as `.ssh`
2. directly in your home folder
3. at the root of a drive

To keep it to some folders only, add `--allow-path` and a folder after `--mcp` in the copied text, once per folder. For example `--mcp --allow-path D:/parts`.

It then works only in those folders, the folder of your open document and the app's own folders. When it is refused a file, it says why and which folder would let it through.

### In the Flatpak

The Flatpak keeps the assistant's files in the FundaCAD folder inside your Documents folder. FundaCAD makes that folder when it starts.

For any other file, FundaCAD asks you. The file chooser opens with that file filled in and a title such as "An assistant asks to save bracket.funda". Pick a file to let it through, or press Cancel to refuse.

FundaCAD can only ask while its window is open and Live document is set to share. Otherwise the assistant works only in the FundaCAD folder.

## Long replies on big models

A reply that lists every body, face or clash of a big model would fill the assistant's memory with rows that say the same thing. So once a model has more than 10 bodies:

1. a reply starts with a summary, the counts and totals
2. bodies alike in all but their names fold into one row
3. it shows 30 rows

A pattern of 3,000 pins reads as one row:

```
body1 "Pin": 2.0 x 2.0 x 2.0 mm, vol 8 mm3, 6 faces, 12 triangles (and 2999 more alike: body4..body3002, named "Pin 2".."Pin 3000")
```

Nothing is out of reach. The last line of a shortened reply says how to ask for the rest, and the assistant asks only for what it needs:

1. `offset` pages on to the next rows, and `limit` 0 shows every row.
2. `body` or `bodies` narrows the reply to the parts it names.
3. `detail` and `selectors` on inspect add the faces and edges, 5 bodies a page once there are more than 10.
4. `outline` on section adds the loop points.
5. A clash check that steps a parameter (`sweep`) gives each step with more than 10 clashing pairs as their total and the 10 largest.
6. `full` gives the whole reply, one row per body, pair or file.

You do not set any of this yourself, the assistant reads the summary and asks for the details.
