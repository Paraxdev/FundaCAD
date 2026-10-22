// The What's new card on Home after an update, fed by the release notes bundled at build time.

import { getRecentFiles } from "../io/recentFiles";
import { RELEASE_TAG } from "../plugins";
import { useWhatsNewStore } from "../stores/whatsNew";
import { toast } from "./toast";
import { appVersion } from "./updates";

export interface NotesGroup {
  title: string;
  bullets: string[];
}

export interface WhatsNewInput {
  dev: boolean;
  /** At least one recent document: a brand new install has none. */
  returning: boolean;
  seen: string | null;
  hash: string;
}

export interface WhatsNewHome {
  isOpen(): boolean;
  open(): void;
}

const SEEN_KEY = "fundacad.whatsNewSeen";
const NOTES_DIR = "../../docs/release-notes/";
const notesFiles = import.meta.glob<string>("../../docs/release-notes/*.md", { query: "?raw", import: "default" });

export function whatsNewSection(md: string): string {
  const lines = md.split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+what['’]s new\b/i.test(l));
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2}\s/.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}

function plainText(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseNotes(section: string): NotesGroup[] {
  const groups: NotesGroup[] = [];
  let group: NotesGroup | null = null;
  // A line right under a bullet, or indented after a blank, wraps that bullet as Markdown does.
  let wrapping = false;
  let blank = false;
  for (const line of section.split(/\r?\n/)) {
    if (!line.trim() || /^\s*>/.test(line)) {
      blank = true;
      if (line.trim()) wrapping = false;
      continue;
    }
    const title = /^###+\s+(.*?)\s*#*$/.exec(line)?.[1] ?? /^\s*(\*\*|__)(.+?)\1:?\s*$/.exec(line)?.[2];
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)?.[1];
    if (title !== undefined) {
      group = { title: plainText(title).replace(/:$/, ""), bullets: [] };
      groups.push(group);
      wrapping = false;
    } else if (bullet !== undefined) {
      if (!group) groups.push((group = { title: "", bullets: [] }));
      group.bullets.push(plainText(bullet));
      wrapping = true;
    } else if (wrapping && group && (!blank || /^\s/.test(line))) {
      group.bullets[group.bullets.length - 1] += ` ${plainText(line)}`;
    } else {
      wrapping = false;
    }
    blank = false;
  }
  return groups.filter((g) => g.bullets.length > 0);
}

export function notesHash(text: string): string {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function decideWhatsNew(o: WhatsNewInput): "show" | "record" | "nothing" {
  if (o.dev || o.seen === o.hash) return "nothing";
  return o.returning ? "show" : "record";
}

/** The channel's notes, the beta notes when the channel has none. */
export async function loadNotes(channel: string): Promise<string> {
  const load = notesFiles[`${NOTES_DIR}${channel}.md`] ?? notesFiles[`${NOTES_DIR}beta.md`];
  return load ? await load() : "";
}

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

function writeSeen(hash: string): void {
  try {
    localStorage.setItem(SEEN_KEY, hash);
  } catch {
    // The card still shows this session, blocked storage only means it may show again.
  }
}

export async function startWhatsNew(home: WhatsNewHome, dev: boolean = import.meta.env.DEV): Promise<void> {
  if (dev) return;
  const section = whatsNewSection(await loadNotes(RELEASE_TAG));
  const notes = parseNotes(section);
  if (!notes.length) return;
  const hash = notesHash(section);
  const decision = decideWhatsNew({ dev, returning: getRecentFiles().length > 0, seen: readSeen(), hash });
  if (decision === "nothing") return;
  writeSeen(hash);
  if (decision === "record") return;
  useWhatsNewStore().show(await appVersion(), notes);
  if (!home.isOpen()) toast("FundaCAD was updated.", { action: { label: "What's new", onClick: () => home.open() } });
}
