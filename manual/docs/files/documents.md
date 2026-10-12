# Saving and documents

Your work lives in a document, a single file that holds the whole model: the sketches, the steps, the parameters and anything you imported. Open it later and you carry on where you left off, history included.

## Saving

File, Save (Ctrl+S) writes the document to its file. File, Save As (Ctrl+Shift+S) asks where, and lets you choose between two kinds of file.

A `.funda` file is plain readable text. Use it if you keep your projects in a version control tool such as git, because you can see what changed between two saves.

A `.fundab` file is the compact version. It is noticeably smaller, which helps with models that contain big imports, and it carries error correction, so a file that got a little damaged on disk can often repair itself when you open it. FundaCAD tells you when that happens, and saving again writes a clean copy.

FundaCAD looks at what is inside a file and not at its name, so a file with the wrong ending still opens. Files saved by earlier versions of the app open too. If a file was saved by a newer version than the one you have, FundaCAD says so, asks you to update, and leaves your current document alone.

The welcome window lists the last ten documents you opened under Recent, and Help, Welcome Screen brings it back.

If a document needs a plugin that is switched off or missing, FundaCAD tells you when you open it. The file opens and keeps all its values, but the steps that plugin made cannot build until you turn it back on.

## When something goes wrong

While you have unsaved changes, FundaCAD quietly keeps a recovery copy. It saves a snapshot about half a minute after you stop changing things, and at least every two minutes while you keep working. A normal save clears it.

If the app closes before you could save, the next start asks whether to recover the unsaved work, and names the document and the age of the snapshot. Choose Recover to restore it or Discard to delete it. After recovering, use Save As to keep it.

## Versions

Saving a file overwrites the last one. Versions are for the times when you want to be able to go back, like a checkpoint before a risky change. Open them with the Versions button in the column of controls at the edge of the viewport.

Type a short note into What changed, such as "thicker walls", and press Save version. The list shows each version with its note, how long ago it was saved, and a one-line summary of what it changed. Click one to see which steps were added, changed or removed.

Restore takes the document back to that version, and Ctrl+Z brings back what you had. Branch from here starts a separate line of work from that point, which is the safe way to try a risky idea. Once you have more than one branch, a picker at the top of the panel switches between them.

Versions are stored inside the document, so they travel with the file. There is no merging, so two branches stay two separate designs.

## Bringing in another document

Insert Document, under Insert on the rail, puts one FundaCAD document into another. That is how you build a part that has to fit around something you modelled earlier, such as a case around a board you already drew.

Choose the file, then choose how. Append copies the shape in once, and from then on it is yours. Link also copies it in, but remembers the file it came from, so you can refresh it when the original changes.

What arrives is the finished shape of the other document as an imported body, without its sketches and steps. You can move it, cut with it and export it, but you cannot go into its history.

When you open a document with a linked body, FundaCAD checks the original file. If it has changed, a message says so and has an Update button. If the file has moved, the message says that. You can also right-click the linked step in the History and choose Update from linked file, or Unlink to cut the connection and keep the shape as it is.
