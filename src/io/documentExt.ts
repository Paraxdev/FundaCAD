// What a saved document is called on disk. Past names (.sindri, .neocad) open forever since files on disk cannot be
// upgraded, and nothing renames an opened file; only Save As offers the new name. Keep in step with
// src-tauri/src/lib.rs, which gates double-click open on the same names (a mismatch opens a blank window).

/** The extension new documents are saved as: readable JSON. */
export const DOC_EXT = "funda";

/** The compact binary document. Rust picks the save format from this extension (src-tauri/src/json_doc.rs);
 *  opening reads the format from the bytes, so a misnamed file still opens. */
export const BINARY_DOC_EXT = "fundab";

/** The extensions documents were saved as before, newest first, the order the strip regex needs. Read forever. */
export const LEGACY_DOC_EXTS: readonly string[] = ["neocad", "sindri"];

/** Every extension that names one of our documents, `json` included: a pre-v5
 *  document is plain JSON and some are still called that. */
export const DOC_EXTS: readonly string[] = [DOC_EXT, BINARY_DOC_EXT, ...LEGACY_DOC_EXTS, "json"];

/** Is this extension one of ours? Case-insensitive, and tolerant of the
 *  `undefined` that `split(".").pop()` yields for a name with no dot. */
export function isDocumentExt(ext: string | undefined | null): boolean {
  return typeof ext === "string" && DOC_EXTS.includes(ext.toLowerCase());
}

/** A file name with any of our extensions removed, past ones too, so `bracket.neocad` exports as `bracket.stl`. */
export function stripDocumentExt(name: string): string {
  const alts = [BINARY_DOC_EXT, DOC_EXT, ...LEGACY_DOC_EXTS].join("|");
  return name.replace(new RegExp(`\\.(${alts})$`, "i"), "");
}

/** The notice for a save that cannot hold the sections a `.fundab` carried, or
 *  null when nothing is lost. A JSON file has no sections, so only a `.fundab`
 *  keeps them. */
export function leftOutSectionsNotice(path: string, carried: readonly { name: string }[]): string | null {
  if (carried.length === 0) return null;
  if ((path.split(".").pop() ?? "").toLowerCase() === BINARY_DOC_EXT) return null;
  const names = carried.map((c) => c.name).join(", ");
  return `Saved without ${carried.length === 1 ? "a section" : `${carried.length} sections`} (${names}) that this version of FundaCAD does not read. Save as .${BINARY_DOC_EXT} to keep ${carried.length === 1 ? "it" : "them"}.`;
}
