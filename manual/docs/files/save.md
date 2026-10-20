# Saving

A document is one file that holds the whole model, with its steps, parameters and imports.

<!-- shot: save-as-dialog | Save As offering .funda and .fundab -->

Ctrl+S saves and Ctrl+Shift+S asks where. A `.funda` file is readable text that suits git. A `.fundab` file is smaller and can often repair itself if the disk damages it. Saving it is fast even when the document holds a big import.

While you have unsaved changes, FundaCAD keeps a recovery copy. If the app closes first, the next start offers to recover it.

Saving also takes a picture of the model for its card on [Home](home.md). The picture is kept on this computer, not in the file.

## Files from a newer version

A file saved by a newer version of FundaCAD still opens. Features this version does not know show greyed in the history, named by their type, and a notice lists them. They are kept, and saving writes them back unchanged, so the newer version still has them.

Bodies made after such a feature may differ, because this version builds without it. Open the file in the newer version to see it as it was made.

Versions saved by the newer version are kept the same way, until you save a version here, which starts a new list in their place. The Versions panel says so.

A .fundab file can also hold parts this version does not read. Saving it as .fundab keeps them, saving it as .funda does not.
