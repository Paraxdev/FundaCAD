// What a plugin is allowed to do, and how that is said to the person deciding.
//
// This module is pure and Vue-free on purpose: it is the vocabulary, and the
// vocabulary has to be readable from a test, from the installer, and from the
// dialog without any of them starting an app.
//
// Two rules hold everything else up.
//
// FAIL CLOSED. A manifest naming a grant this table does not know is REFUSED,
// not ignored and not passed through. An unknown grant means we cannot say what
// the plugin wants, and the only safe reading of "I cannot say what you want"
// is no. The alternative, dropping the ones we do not recognise, installs a
// plugin under a description that is missing the interesting line.
//
// THE PROMISE IS A VALUE. `promiseOf()` reduces a manifest to the part that was
// actually consented to. Consent is recorded against that string, so a later
// version asking for the same or less installs quietly and one asking for more
// has to ask again. A version number could not do this job: it is a claim by
// whoever published it, where the promise is a fact about what was shown.

/** Everything a plugin can ask for. Closed set, deliberately small. */
export const GRANTS = [
  "document.read",
  "document.write",
  "document.history",
  "geometry.build",
  "files.read",
  "files.write",
  "network",
  "printer.control",
  "ui.panel",
  "process.spawn",
] as const;

export type Grant = (typeof GRANTS)[number];

/** Where the plugin's code runs. The kind decides how much of the sandbox is
 *  the operating system's word and how much is ours, which is the difference
 *  the install screen has to tell the truth about. */
export const PLUGIN_KINDS = ["process", "panel", "compute"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

interface GrantCopy {
  /** shown under "It can" */
  can: string;
  /** shown under "It cannot", when the plugin did NOT ask for this one. Absent
   *  where the absence is not worth a line: nobody reads "cannot add a panel"
   *  and learns anything, and a list padded with those is a list nobody reads
   *  at all. */
  cannot?: string;
}

const COPY: Record<Grant, GrantCopy> = {
  "document.read": { can: "Read the document you have open" },
  "document.write": {
    can: "Change the document you have open",
    cannot: "Change your document",
  },
  "document.history": { can: "See your edit history" },
  "geometry.build": { can: "Use the geometry engine to build and measure shapes" },
  "files.read": { can: "Read files you pick for it" },
  "files.write": { can: "Save files where you tell it to" },
  // `can` is filled in with the hosts, which is the whole reason this grant
  // carries them: "can use the internet" is not a decision anybody can make.
  "network": { can: "Connect to the internet", cannot: "Use the internet" },
  "printer.control": {
    can: "Send jobs to your printer and read its status",
    cannot: "Touch your printer",
  },
  "ui.panel": { can: "Add a panel to the window" },
  "process.spawn": {
    can: "Start other programs on your computer",
    cannot: "Start other programs on your computer",
  },
};

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  /** one line, shown in the catalogue row */
  summary: string;
  grants: Grant[];
  /** required when, and only when, `network` is granted */
  hosts: string[];
}

export type ParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; why: string };

const ID = /^[a-z][a-z0-9-]{0,31}$/;
// A hostname, or a leading-dot suffix that stands for one level of subdomain.
// No scheme, no path, no wildcard in the middle: a host allowlist that can
// express `*.anything.com` is not much of an allowlist.
const HOST = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const isGrant = (v: unknown): v is Grant => (GRANTS as readonly unknown[]).includes(v);
const isKind = (v: unknown): v is PluginKind =>
  (PLUGIN_KINDS as readonly unknown[]).includes(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Validate an untrusted manifest. Every rejection names its reason, because a
 *  publisher whose bundle will not install needs to know which line to fix and
 *  a user reading a refusal deserves better than "invalid". */
export function parseManifest(raw: unknown): ParseResult {
  if (!raw || typeof raw !== "object") return { ok: false, why: "not an object" };
  const r = raw as Record<string, unknown>;

  const id = str(r.id);
  if (!ID.test(id)) return { ok: false, why: `not a plugin id: ${JSON.stringify(r.id)}` };
  const name = str(r.name);
  if (!name) return { ok: false, why: "no name" };
  const version = str(r.version);
  if (!version) return { ok: false, why: "no version" };
  if (!isKind(r.kind)) return { ok: false, why: `not a plugin kind: ${JSON.stringify(r.kind)}` };

  if (!Array.isArray(r.grants)) return { ok: false, why: "grants must be a list" };
  const grants: Grant[] = [];
  for (const g of r.grants) {
    if (!isGrant(g)) return { ok: false, why: `unknown permission: ${JSON.stringify(g)}` };
    if (grants.includes(g)) return { ok: false, why: `permission asked for twice: ${g}` };
    grants.push(g);
  }

  const hostsRaw = r.hosts === undefined ? [] : r.hosts;
  if (!Array.isArray(hostsRaw)) return { ok: false, why: "hosts must be a list" };
  const hosts = hostsRaw.map(str);
  for (const h of hosts) {
    if (!HOST.test(h)) return { ok: false, why: `not a host name: ${JSON.stringify(h)}` };
  }

  // Both directions are errors, and for the same reason: a permission and the
  // thing it is scoped to have to arrive together or the screen shows something
  // that is not what will be enforced.
  if (grants.includes("network") && hosts.length === 0) {
    return { ok: false, why: "network was asked for without naming any hosts" };
  }
  if (!grants.includes("network") && hosts.length > 0) {
    return { ok: false, why: "hosts were named without asking for network" };
  }

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      kind: r.kind,
      summary: str(r.summary),
      grants,
      hosts,
    },
  };
}

/** The two lists the install screen shows.
 *
 *  The second one is the one worth reading. A screen that lists only what was
 *  asked for gives no way to tell a modest plugin from a greedy one, so every
 *  screen looks equally alarming and every screen gets equally ignored. Both
 *  lists come off the same table, so the reassuring one cannot go stale in the
 *  direction that hurts. */
export function describeGrants(manifest: PluginManifest): { can: string[]; cannot: string[] } {
  const held = new Set<Grant>(manifest.grants);
  const can: string[] = [];
  const cannot: string[] = [];
  for (const g of GRANTS) {
    const copy = COPY[g];
    if (held.has(g)) {
      can.push(g === "network" ? `Connect to ${manifest.hosts.join(", ")}` : copy.can);
    } else if (copy.cannot) {
      cannot.push(copy.cannot);
    }
  }
  return { can, cannot };
}

/** A process plugin is a normal program on the machine, and the install screen
 *  has to say so. The OS boundary keeps it out of the app's memory; it does not
 *  keep it out of the user's files, because the user can read the user's files.
 *  Until each platform's sandbox is wired up, what the grants describe is what
 *  it can reach THROUGH US, plus a promise about the rest, and a dialog that
 *  implied otherwise would be trading on trust it has not earned. */
export function sandboxNote(kind: PluginKind): string {
  switch (kind) {
    case "process":
      return "This one runs as a normal program on your computer, so the list above is what it can reach through FundaCAD, not a cage around it. Install it only if you trust where it came from.";
    case "panel":
      return "This one runs inside the window with no network and no access to your files, so the list above is all it can do.";
    case "compute":
      return "This one runs as an isolated calculation with no network and no access to your files, so the list above is all it can do.";
  }
}

/** The part of a manifest that was consented to, as a value that can be stored
 *  and compared. Sorted, so the order a publisher happened to write the list in
 *  cannot re-prompt somebody for a promise that has not changed.
 *
 *  Left readable rather than hashed: this is the record of what someone agreed
 *  to, it is a few dozen bytes either way, and being able to open the file and
 *  see the answer is worth more here than being short. */
export function promiseOf(manifest: PluginManifest): string {
  const grants = [...manifest.grants].sort().join(",");
  const hosts = [...manifest.hosts].sort().join(",");
  return hosts ? `${manifest.kind}|${grants}|${hosts}` : `${manifest.kind}|${grants}`;
}

/** Whether an update may install without asking again: same promise, or a
 *  strictly smaller one. Anything else stops and shows the screen. */
export function promiseCovers(consented: PluginManifest, incoming: PluginManifest): boolean {
  if (consented.kind !== incoming.kind) return false;
  const had = new Set<string>(consented.grants);
  const hadHosts = new Set<string>(consented.hosts);
  return (
    incoming.grants.every((g) => had.has(g)) && incoming.hosts.every((h) => hadHosts.has(h))
  );
}
