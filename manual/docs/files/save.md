# Saving

A document is one file that holds the whole model, with its steps, parameters and imports.

<!-- shot: save-as-dialog | Save As offering .funda and .fundab -->

## Save

Ctrl+S saves, and Ctrl+Shift+S (Save As…) asks where. Save As offers two formats:

| Format | What it is |
|---|---|
| `.funda` | Readable text that suits git. |
| `.fundab` | Smaller, and can often repair itself if the disk damages it. It saves fast even when the document holds a big import. |

Saving also takes a picture of the model for its card on [Home](home.md). The picture is kept on this computer, not in the file.

## Recovery

While you have unsaved changes, FundaCAD keeps a recovery copy. If the app closes first, the next start offers to recover it.

## Files from a newer version

A file saved by a newer version of FundaCAD still opens. A notice lists the features this version does not know, and the history shows them greyed, named by their type.

They are kept, and saving writes them back unchanged. Bodies after them may differ, because this version builds without them. Open the file in the newer version to see it as it was made.

Versions saved by the newer version are kept the same way, until you save a version here, which replaces them. The Versions panel says so.

A `.fundab` file can also hold parts this version does not read. Saving it as `.fundab` keeps them, saving it as `.funda` does not.
