import { isDocumentExt } from "./documentExt";
import { IMPORT_EXTS } from "./files";

export type DropAction = "open" | "import" | "environment" | "reject";

const IMPORTABLE = new Set(IMPORT_EXTS.map((e) => e.toLowerCase()));

function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** What a file dropped on the window should do, from its name alone.
 *
 *  Unknown names are refused here because extToImportFormat is total: handed a
 *  .txt it answers "step" and the user gets a STEP reader error about a text
 *  file. */
export function routeDroppedName(name: string): DropAction {
  const base = baseName(name);
  const dot = base.lastIndexOf(".");
  if (dot < 0 || dot === base.length - 1) return "reject";
  const ext = base.slice(dot + 1).toLowerCase();
  if (isDocumentExt(ext)) return "open";
  if (IMPORTABLE.has(ext)) return "import";
  if (ext === "hdr" || ext === "exr") return "environment";
  return "reject";
}

export interface DropPlan<T> {
  /** The document to open first, the first one dropped. */
  open: T | null;
  /** Mesh and CAD files, in drop order, imported after `open`. */
  imports: T[];
  /** Panoramas to light the viewport with; the last one dropped is used. */
  environments: T[];
  /** Further documents, only one can be open at a time. */
  skipped: T[];
  rejected: T[];
}

export function planDrop<T>(items: readonly T[], nameOf: (item: T) => string): DropPlan<T> {
  const plan: DropPlan<T> = { open: null, imports: [], environments: [], skipped: [], rejected: [] };
  for (const item of items) {
    const action = routeDroppedName(nameOf(item));
    if (action === "import") plan.imports.push(item);
    else if (action === "environment") plan.environments.push(item);
    else if (action === "reject") plan.rejected.push(item);
    else if (plan.open === null) plan.open = item;
    else plan.skipped.push(item);
  }
  return plan;
}

/** One sentence about what a drop left out, or null when it took everything. */
export function describeDropLeftovers<T>(plan: DropPlan<T>, nameOf: (item: T) => string): string | null {
  const parts: string[] = [];
  const names = (list: T[]) => list.map((i) => baseName(nameOf(i))).join(", ");
  if (plan.rejected.length) {
    const nothing = plan.open === null && plan.imports.length === 0 && plan.environments.length === 0;
    parts.push(
      `${nothing ? "Nothing was imported" : "Not imported"}, FundaCAD cannot read ${names(plan.rejected)}.`,
    );
  }
  if (plan.skipped.length) {
    parts.push(`Only one document opens at a time, so ${names(plan.skipped)} stayed closed.`);
  }
  return parts.length ? parts.join(" ") : null;
}
