import { formatEntry, type LogEntry } from "./logStore";

export const REPO_URL = "https://github.com/Paraxdev/fundacad";
// GitHub refuses an issue body over 65,536 characters, and the body also holds the description from the URL, the
// form's headings and the steps the user types.
export const REPORT_CAP = 55_000;
// Windows URL handlers have truncated near 2,048 characters.
export const URL_CAP = 2_000;
export const ERROR_DETAIL_CAP = 4_000;
export const RECENT_ERRORS = 3;
export const BUG_FORM_FIELDS = ["what", "version", "os"] as const;

const TITLE_CODE_POINTS = 70;
const URL_CUT_MARKER = " … (cut, the full text is in the pasted report)";
const DETAIL_CUT_MARKER = "\n… (cut at 4,000 characters)";
const LOG_HEADING = "app log (the end, user names hidden):";
const LOG_CUT_HEADING = "app log (the end, user names hidden, cut to fit):";

export interface ReportInput {
  version: string;
  channel: string;
  system: string;
  webview: string | null;
  userAgent: string;
  connected: boolean;
  safeMode: string | null;
  plugins: readonly string[];
  description: string;
  events: readonly string[];
  errors: readonly string[];
  pipeline: readonly string[];
  log: string | null;
  document: string | null;
}

export interface Report {
  text: string;
  logCut: boolean;
  /** The document's length when it was left out to fit the cap. */
  documentLeftOut: number | null;
}

export function cutCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  return Array.from(text).slice(0, max).join("");
}

const wellFormed = (text: string) =>
  text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");

function redactAfter(text: string, needle: string, ends: (c: string) => boolean): string {
  // ASCII only lowering, as Rust's to_ascii_lowercase: a full lowering can change the length ("İ" becomes two units).
  const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  let out = "";
  let i = 0;
  for (let at = lower.indexOf(needle, i); at >= 0; at = lower.indexOf(needle, i)) {
    const name = at + needle.length;
    out += text.slice(i, name);
    let end = name;
    while (end < text.length && !ends(text[end]!)) end++;
    if (end > name) out += "[REDACTED]";
    i = end;
  }
  return out + text.slice(i);
}

/** Mirrors redact_user_paths in src-tauri/src/log_file.rs; tests/fixtures/redact_cases.json holds both to it. */
export function redactUserPaths(text: string): string {
  const unixEnd = (c: string) => "/\\\"'".includes(c) || /\s/.test(c);
  const s = redactAfter(text, "\\users\\", (c) => "/\\\"'\n\r".includes(c));
  return redactAfter(redactAfter(s, "/home/", unixEnd), "/users/", unixEnd);
}

export function recentErrors(entries: readonly LogEntry[], n = RECENT_ERRORS): string[] {
  return entries
    .filter((e) => e.level === "error")
    .slice(-n)
    .map((e) => {
      const cut = e.detail !== undefined && e.detail.length > ERROR_DETAIL_CAP;
      const detail = cut ? cutCodePoints(e.detail!, ERROR_DETAIL_CAP) + DETAIL_CUT_MARKER : e.detail;
      return redactUserPaths(formatEntry({ ...e, ...(detail !== undefined ? { detail } : {}) }));
    });
}

function section(heading: string, lines: readonly string[]): string[] {
  return ["", heading, ...lines];
}

function assemble(r: ReportInput, log: { heading: string; text: string } | null, document: string | null): string {
  return [
    "FundaCAD problem report (format 2)",
    `version: ${r.version} · channel ${r.channel}`,
    `system: ${r.system}`,
    ...(r.webview ? [`webview: ${r.webview}`] : []),
    `browser: ${r.userAgent}`,
    `geometry engine connected: ${r.connected}`,
    `safe mode: ${r.safeMode ?? "off"}`,
    `plugins: ${r.plugins.length ? r.plugins.join(", ") : "none"}`,
    "",
    r.description,
    ...section(
      "recent events:",
      r.events.map((c) => `  ${c}`),
    ),
    ...(r.errors.length ? section("recent errors:", r.errors) : []),
    ...section(
      "render pipeline:",
      r.pipeline.map((c) => `  ${c}`),
    ),
    ...(log ? section(log.heading, [log.text]) : []),
    ...(document !== null ? section("document:", [document]) : []),
  ].join("\n");
}

/** The end of `log` within `room` characters, from a line start; null when not even its last line fits. */
function logEnd(log: string, room: number): string | null {
  if (room >= log.length) return log;
  if (room <= 0) return null;
  const end = log.slice(-room);
  if (log[log.length - room - 1] === "\n") return end;
  const from = end.indexOf("\n");
  return from < 0 ? null : end.slice(from + 1);
}

/** The log is cut from its start first, since its end is what matters; the document goes only when that is not
 *  enough, and the dialog says so. */
export function buildReport(r: ReportInput, cap = REPORT_CAP): Report {
  const log = r.log?.trimEnd() || null;
  for (const document of r.document !== null ? [r.document, null] : [null]) {
    const documentLeftOut = document === null && r.document !== null ? r.document.length : null;
    const whole = assemble(r, log ? { heading: LOG_HEADING, text: log } : null, document);
    if (whole.length <= cap) return { text: whole, logCut: false, documentLeftOut };
    if (!log) continue;
    const overhead = assemble(r, { heading: LOG_CUT_HEADING, text: "" }, document).length;
    const kept = logEnd(log, cap - overhead);
    if (kept !== null) {
      return { text: assemble(r, { heading: LOG_CUT_HEADING, text: kept }, document), logCut: true, documentLeftOut };
    }
  }
  // Only a description or events this long are left: the report still goes, without the log.
  return { text: assemble(r, null, null), logCut: log !== null, documentLeftOut: r.document?.length ?? null };
}

export function issueTitle(description: string): string {
  const first = description.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  return `Problem: ${cutCodePoints(wellFormed(first.trim()), TITLE_CODE_POINTS)}`;
}

export function issueUrl(fields: { description: string; version: string; system: string }): string {
  const q = (name: string, value: string) => `&${name}=${encodeURIComponent(wellFormed(value))}`;
  const head =
    `${REPO_URL}/issues/new?template=bug.yml` +
    q("title", issueTitle(fields.description)) +
    q("version", fields.version) +
    q("os", fields.system);
  const room = URL_CAP - head.length - "&what=".length;
  const what = wellFormed(fields.description);
  if (encodeURIComponent(what).length <= room) return head + q("what", what);
  const points = Array.from(what);
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const fits = encodeURIComponent(points.slice(0, mid).join("") + URL_CUT_MARKER).length <= room;
    if (fits) lo = mid;
    else hi = mid - 1;
  }
  return head + q("what", points.slice(0, lo).join("") + URL_CUT_MARKER);
}

export function ideaUrl(): string {
  return `${REPO_URL}/issues/new?template=idea.yml`;
}
