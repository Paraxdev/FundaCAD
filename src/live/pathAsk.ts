// An assistant's request for a path outside the Flatpak's FundaCAD folder, shown as the window's own file dialog.
// In the Flatpak that dialog is the file chooser portal, so the user's pick comes back as a path the sandbox can
// reach. No Vue import: liveSession.ts loads this and the headless suite reaches that file.

import { dialogExts, nativeDialog } from "../io/nativeDialog";

export type AskKind = "open" | "save" | "folder";

/** One ask as a `session_host` reply carries it. */
export interface PathAsk {
  askId: string;
  kind: AskKind;
  tool: string;
  path: string;
  exts: string[];
  name: string;
}

/** Shows one ask and resolves to the picked path, or null when the user cancels. */
export type AskUser = (ask: PathAsk) => Promise<string | null>;

type Dialog = Pick<Awaited<ReturnType<typeof nativeDialog>>, "open" | "save">;

const KINDS: readonly string[] = ["open", "save", "folder"];

const VERBS: Record<string, string> = {
  doc_open: "open",
  doc_import: "import",
  doc_save: "save",
  export: "export",
};

/** The ask, or null for anything malformed, which is then left unanswered. */
export function parseAsk(x: unknown): PathAsk | null {
  if (!x || typeof x !== "object") return null;
  const a = x as Record<string, unknown>;
  if (typeof a["askId"] !== "string" || !a["askId"]) return null;
  if (typeof a["kind"] !== "string" || !KINDS.includes(a["kind"])) return null;
  if (typeof a["path"] !== "string" || !a["path"]) return null;
  const exts = Array.isArray(a["exts"]) ? a["exts"].filter((e): e is string => typeof e === "string" && !!e) : [];
  return {
    askId: a["askId"],
    kind: a["kind"] as AskKind,
    tool: typeof a["tool"] === "string" ? a["tool"] : "",
    path: a["path"],
    exts,
    name: typeof a["name"] === "string" && a["name"].trim() ? a["name"].trim() : "an assistant",
  };
}

/** The dialog title, which says who asks for what: "An assistant asks to save bracket.funda". */
export function askTitle(ask: PathAsk): string {
  const who = ask.name.charAt(0).toUpperCase() + ask.name.slice(1);
  const verb = VERBS[ask.tool] ?? (ask.kind === "save" ? "save" : "open");
  const file = ask.path.split(/[\\/]/).filter(Boolean).pop() ?? ask.path;
  return `${who} asks to ${verb}${ask.kind === "folder" ? " into" : ""} ${file}`;
}

/** Opens the dialog the ask names, prefilled with the asked path. */
export async function askWithDialog(ask: PathAsk, dialog: Dialog): Promise<string | null> {
  const base = { title: askTitle(ask), defaultPath: ask.path };
  const filters =
    ask.exts.length && ask.kind !== "folder"
      ? { filters: [{ name: ask.exts.map((e) => e.toUpperCase()).join(", "), extensions: dialogExts(ask.exts) }] }
      : {};
  const picked =
    ask.kind === "save"
      ? await dialog.save({ ...base, ...filters })
      : await dialog.open({ ...base, ...filters, multiple: false, directory: ask.kind === "folder" });
  return typeof picked === "string" && picked ? picked : null;
}

export const askUserPath: AskUser = async (ask) => askWithDialog(ask, await nativeDialog());
