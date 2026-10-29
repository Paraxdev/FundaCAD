# Saving

A document is one file that holds the whole model, with its steps, parameters and imports.

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

A file saved by a newer version of FundaCAD still opens. A notice lists the steps this version does not know.

- The History shows those steps greyed, and saving writes them back unchanged.
- The bodies after them may differ until you open the file in the newer version.
- The file's saved versions are kept until you save a version here.
- Parts of a `.fundab` file that this version does not read are kept only if you save it as `.fundab` again.
