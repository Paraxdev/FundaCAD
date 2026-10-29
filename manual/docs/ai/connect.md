# Connect an AI assistant

FundaCAD has a built-in server that lets an AI assistant build and check parts with the same engine as the app. It works with any assistant that supports MCP.

<!-- shot: prefs-ai-assistants | AI assistants page with the Copy button -->

Open Edit, Preferences (Ctrl+,) and choose AI assistants. Pick your assistant under How to connect it, and copy the text shown, which has your real path filled in.

For Claude Code it is one `claude mcp add` command, then start a new session. For Claude Desktop, add the block to `claude_desktop_config.json` through Settings, Developer, Edit Config, and restart.

## Where it may open and save files

The assistant can open, import, save and export files in any of your folders. It never reads or writes in hidden folders (names that start with a dot, such as `.ssh`), directly in your home folder or at the root of a drive, so save in a folder inside them.

To keep it to some folders only, add `--allow-path` and a folder after `--mcp` in the copied text, once per folder, for example `--mcp --allow-path D:/parts`. It then works only in those folders, the folder of the document you have open, and the app's own folders. When it is refused a file, it says why and which folder would let it through.

## Long replies on big models

A reply that lists every body, face or clash of a big model would fill the assistant's memory with rows that say the same thing. So over 10 bodies a reply starts with a summary, the counts and totals, folds bodies alike in all but their names into one row and shows 30 rows. A pattern of 3,000 pins reads as one row:

```
body1 "Pin": 2.0 x 2.0 x 2.0 mm, vol 8 mm3, 6 faces, 12 triangles (and 2999 more alike: body4..body3002, named "Pin 2".."Pin 3000")
```

Nothing is out of reach. The last line of a shortened reply says how to ask for the rest, and the assistant asks only for what it needs:

- `offset` pages on to the next rows, and `limit` 0 shows every row.
- `body` or `bodies` narrows the reply to the parts it names.
- `detail` and `selectors` on inspect add the faces and edges, 5 bodies a page, and `outline` on section adds the loop points.
- `full` gives the whole reply, one row per body, pair or file.

You do not set any of this yourself, the assistant reads the summary and asks for the details.
