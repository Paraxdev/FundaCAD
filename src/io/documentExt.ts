// What a saved document is called on disk.
//
// The app has been called three things. It saved `.sindri`, then `.neocad`, and
// it saves `.funda` now — and it opens all three, permanently. That asymmetry is
// the whole design: an extension is not a brand decision once files exist,
// because every `.sindri` and every `.neocad` already on someone's disk or in
// someone's repository has to keep opening, and there is no upgrade step that
// can reach them. Reading an old name costs one array entry; refusing it costs
// the user their work.
//
// A LIST rather than a second constant, because there is now more than one past
// name and there will be more than two if this happens again. The order is
// newest first, which is the order a reader wants and the order the strip regex
// wants (a longer name that ends in a shorter one would otherwise strip badly).
//
// Nothing rewrites an existing file's name. Opening a `.neocad` and saving over
// it keeps the `.neocad`; only Save As offers the new name. Silently renaming
// what someone opened would break their own links to it.
//
// Kept apart from files.ts so the Rust side has one obvious counterpart to stay
// in step with — src-tauri/src/lib.rs gates the double-click open path on the
// same names, and a mismatch there means an association that opens a blank
// window rather than an error.

/** The extension new documents are saved as. */
export const DOC_EXT = "funda";

/** The extensions documents were saved as before, newest first. Read forever. */
export const LEGACY_DOC_EXTS: readonly string[] = ["neocad", "sindri"];

/** Every extension that names one of our documents, `json` included: a pre-v5
 *  document is plain JSON and some are still called that. */
export const DOC_EXTS: readonly string[] = [DOC_EXT, ...LEGACY_DOC_EXTS, "json"];

/** Is this extension one of ours? Case-insensitive, and tolerant of the
 *  `undefined` that `split(".").pop()` yields for a name with no dot. */
export function isDocumentExt(ext: string | undefined | null): boolean {
  return typeof ext === "string" && DOC_EXTS.includes(ext.toLowerCase());
}

/** A file name with our extension removed, whichever one it carries.
 *
 *  Used to derive a default name for an export, so it has to strip every past
 *  extension too: a part opened from `bracket.neocad` should export as
 *  `bracket.stl`, not `bracket.neocad.stl`.
 */
export function stripDocumentExt(name: string): string {
  const alts = [DOC_EXT, ...LEGACY_DOC_EXTS].join("|");
  return name.replace(new RegExp(`\.(${alts})$`, "i"), "");
}
