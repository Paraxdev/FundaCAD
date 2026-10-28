// The one way to speak to a screen reader: Announcer.vue mounts the two live regions once at boot, outside any
// inert subtree, and everything transient (prompts, results, errors) goes through announce().

export type AnnouncePriority = "polite" | "assertive";
export type Verbosity = "off" | "errors" | "normal" | "verbose";

export interface AnnounceOptions {
  /** Spoken only at Verbose. */
  verbose?: boolean;
  /** One source: a newer text with the same key replaces one still waiting. */
  key?: string;
  /** With `key`, waits this long after the last call, for sources that fire while the pointer moves. */
  delay?: number;
}

export interface Announcement {
  text: string;
  priority: AnnouncePriority;
  at: number;
}

interface Region {
  textContent: string | null;
}

interface Pending {
  text: string;
  key: string | undefined;
}

const MAX_BATCH = 3;
const MAX_HISTORY = 30;
// A hidden window runs no frames, so a timer flushes in its place.
const FRAME_FALLBACK_MS = 100;
// Alternated onto a repeat, since VoiceOver drops an announcement identical to the last one.
const REPEAT_MARK = "\u00a0";

let readVerbosity: () => Verbosity = () => "normal";

/** Lane a5's Accessibility settings plug the Announcements setting in here; Normal until then. */
export function setVerbositySource(read: () => Verbosity): void {
  readVerbosity = read;
}

export function verbosity(): Verbosity {
  try {
    return readVerbosity();
  } catch {
    return "normal";
  }
}

function heard(priority: AnnouncePriority, verbose: boolean): boolean {
  const v = verbosity();
  if (v === "off") return false;
  if (v === "errors") return priority === "assertive";
  return v === "verbose" || !verbose;
}

/** Text as a screen reader should hear it: glyphs some voices skip or spell out become words. */
export function spoken(text: string): string {
  return text
    .replace(/\s*·\s*/g, ", ")
    .replace(/⌀\s*/g, "diameter ")
    .replace(/²/g, " squared")
    .replace(/³/g, " cubed")
    .replace(/⌘(?![-+])\s*/g, "Command ")
    .replace(/⌘/g, "Command")
    .replace(/⌥(?![-+])\s*/g, "Option ")
    .replace(/⌥/g, "Option")
    .replace(/…/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function joined(parts: readonly string[]): string {
  return parts.reduce((all, p) => (!all ? p : /[.!?:]$/.test(all) ? `${all} ${p}` : `${all}. ${p}`), "");
}

class Channel {
  region: Region | null = null;
  pending: Pending[] = [];
  last = "";
  marked = false;
  private frame: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly priority: AnnouncePriority) {}

  push(text: string, key: string | undefined) {
    if (key !== undefined) this.pending = this.pending.filter((p) => p.key !== key);
    if (this.pending.some((p) => p.text === text)) return;
    this.pending.push({ text, key });
    if (this.pending.length > MAX_BATCH) this.pending.splice(0, this.pending.length - MAX_BATCH);
    this.schedule();
  }

  schedule() {
    if (!this.region || this.frame !== null || this.timer !== null || !this.pending.length) return;
    // Cleared now and set a frame later, so the region reports a change even for a sentence it already holds.
    this.region.textContent = "";
    const run = () => this.flush();
    if (typeof requestAnimationFrame === "function") this.frame = requestAnimationFrame(run);
    this.timer = setTimeout(run, typeof requestAnimationFrame === "function" ? FRAME_FALLBACK_MS : 16);
  }

  cancel() {
    if (this.frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    if (this.timer !== null) clearTimeout(this.timer);
    this.frame = null;
    this.timer = null;
  }

  flush() {
    this.cancel();
    if (!this.region || !this.pending.length) return;
    let text = joined(this.pending.map((p) => p.text));
    this.pending = [];
    if (text === this.last) {
      this.marked = !this.marked;
    } else {
      this.last = text;
      this.marked = false;
    }
    if (this.marked) text += REPEAT_MARK;
    this.region.textContent = text;
    remember(this.last, this.priority);
  }
}

const channels: Record<AnnouncePriority, Channel> = {
  polite: new Channel("polite"),
  assertive: new Channel("assertive"),
};
const waiting = new Map<string, ReturnType<typeof setTimeout>>();
const history: Announcement[] = [];

function remember(text: string, priority: AnnouncePriority) {
  history.push({ text, priority, at: Date.now() });
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
}

/** Speaks `text` once through the live regions. Errors are assertive, everything else polite. */
export function announce(text: string, priority: AnnouncePriority = "polite", opts: AnnounceOptions = {}): void {
  const line = spoken(text);
  if (!line || !heard(priority, opts.verbose === true)) return;
  const { key, delay } = opts;
  if (key !== undefined && delay !== undefined && delay > 0) {
    const was = waiting.get(key);
    if (was !== undefined) clearTimeout(was);
    waiting.set(
      key,
      setTimeout(() => {
        waiting.delete(key);
        channels[priority].push(line, key);
      }, delay),
    );
    return;
  }
  channels[priority].push(line, key);
}

/** Drops a keyed announcement still waiting, as when the hover it described has ended. */
export function cancelAnnouncement(key: string): void {
  const was = waiting.get(key);
  if (was !== undefined) clearTimeout(was);
  waiting.delete(key);
  for (const c of Object.values(channels)) c.pending = c.pending.filter((p) => p.key !== key);
}

/** Called by Announcer.vue once its regions exist; anything said before that is spoken then. */
export function attachAnnouncer(regions: Record<AnnouncePriority, Region>): () => void {
  for (const c of Object.values(channels)) {
    c.cancel();
    c.region = regions[c.priority];
    c.schedule();
  }
  return () => {
    for (const c of Object.values(channels)) {
      if (c.region !== regions[c.priority]) continue;
      c.cancel();
      c.region = null;
    }
  };
}

/** What was spoken lately, oldest first, for a Show last message command and for tests. */
export function recentAnnouncements(): readonly Announcement[] {
  return history.slice();
}
