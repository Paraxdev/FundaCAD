// What a saved document is called on disk.
//
// The app used to save `.sindri`. It saves `.neocad` now, and it opens BOTH,
// permanently. That asymmetry is the whole design: an extension is not a brand
// decision once files exist, because every `.sindri` already on someone's disk
// or in someone's repository has to keep opening, and there is no upgrade step
// that can reach them. Reading the old name costs one array entry; refusing it
// costs the user their work.
//
// Nothing rewrites an existing file's name. Opening a `.sindri` and saving over
// it keeps the `.sindri`; only Save As offers the new name. Silently renaming
// what someone opened would break their own links to it.
//
// Kept apart from files.ts so the Rust side has one obvious counterpart to stay
// in step with — src-tauri/src/lib.rs gates the double-click open path on the
// same two names, and a mismatch there means an association that opens a blank
// window rather than an error.

/** The extension new documents are saved as. */
export const DOC_EXT = "neocad";

/** The extension documents were saved as before the rename. Read forever. */
export const LEGACY_DOC_EXT = "sindri";

/** Every extension that names one of our documents, `json` included: a pre-v5
 *  document is plain JSON and some are still called that. */
export const DOC_EXTS: readonly string[] = [DOC_EXT, LEGACY_DOC_EXT, "json"];

/** Is this extension one of ours? Case-insensitive, and tolerant of the
 *  `undefined` that `split(".").pop()` yields for a name with no dot. */
export function isDocumentExt(ext: string | undefined | null): boolean {
  return typeof ext === "string" && DOC_EXTS.includes(ext.toLowerCase());
}

/** A file name with our extension removed, whichever one it carries.
 *
 *  Used to derive a default name for an export, so it has to strip the old
 *  extension too: a part opened from `bracket.sindri` should export as
 *  `bracket.stl`, not `bracket.sindri.stl`.
 */
export function stripDocumentExt(name: string): string {
  return name.replace(new RegExp(`\\.(${DOC_EXT}|${LEGACY_DOC_EXT})$`, "i"), "");
}
