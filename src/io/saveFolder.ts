let folder: string | null = null;

/** Where the first Save As of a document with no path opens, set when Home starts
 *  one in a project folder and cleared by the next open. */
export function setSaveFolder(dir: string | null): void {
  folder = dir;
}

export function saveFolder(): string | null {
  return folder;
}

/** Save As's starting point: the document's own path, else its name in the hinted folder. */
export function suggestedSavePath(filePath: string | null, name: string, dir: string | null = folder): string {
  if (filePath) return filePath;
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}
