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
  "device.input",
  "ui.panel",
  "process.spawn",
] as const;

export type Grant = (typeof GRANTS)[number];

/** Where the plugin's code runs. The kind decides how much of the sandbox is
 *  the operating system's word and how much is ours, which is the difference
 *  the install screen has to tell the truth about.
 *
 *  `builtin` is the honest name for a capability that ships inside the app and
 *  is only turned on and off: its code is the app's own code, with the app's
 *  own reach, and nothing sandboxes it. It is here rather than kept in a
 *  separate system because the question a person is answering is the same one
 *  ("what does this thing touch?"), and two vocabularies for one question
 *  produce two screens that describe the same reach differently. What it must
 *  never do is borrow the language of enforcement, which is `sandboxNote`'s
 *  job. */
export const PLUGIN_KINDS = ["builtin", "process", "panel", "compute"] as const;
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
  "device.input": {
    can: "Read the 3D mouse or other input device you have plugged in",
    cannot: "Read any device you plug in",
  },
  "ui.panel": { can: "Add a panel to the window" },
  "process.spawn": {
    can: "Start other programs on your computer",
    cannot: "Start other programs on your computer",
  },
};

export interface PluginManifest {
  /** `Publisher.Name`. See the ID pattern below for why it has two halves. */
  id: string;
  name: string;
  version: string;
  kind: PluginKind;
  /** one line, shown in the catalogue row */
  summary: string;
  grants: Grant[];
  /** required when, and only when, `network` is granted */
  hosts: string[];
  /** Whether a capability that SHIPS with the app runs before anybody has said
   *  anything. Deliberately outside `promiseOf()`: it is a preference, never a
   *  permission, and it decides nothing about reach. A downloaded bundle
   *  setting it gains nothing either, because for a downloaded bundle the
   *  install IS the answer to the question. Defaults to true, so a manifest
   *  that says nothing gets the reading that matches "I installed it". */
  enabledByDefault: boolean;
  /** Ids this plugin used to be published under.
   *
   *  A stored on/off answer is keyed by id, so a rename that dropped the old key
   *  would put the capability back to its default: something a person had turned
   *  OFF would switch itself back on at the version that renamed it, which is
   *  the exact behaviour a toggle exists to prevent.
   *
   *  IT LIVES HERE, in the plugin's own manifest, and not in a table in the app.
   *  A table in the app is the app knowing which plugins exist and what each of
   *  them used to be called, which is the coupling this whole boundary is for.
   *  A plugin knows its own history; nothing else has to.
   *
   *  Read forward and never written back: the new id is what gets saved the next
   *  time anything changes, and until then the old value keeps answering. */
  formerIds: string[];
  /** The `type` values of the document features this plugin OWNS: the ones whose
   *  schema and geometry are the plugin's, not the application's.
   *
   *  Declared in the manifest rather than inferred from what the plugin
   *  contributes at runtime, because the one moment this has to be readable is
   *  the moment the plugin is NOT running. A document full of features nobody
   *  can build is exactly the case that needs a name to put in the warning, and
   *  a plugin that is switched off or uninstalled contributes nothing to ask.
   *  See document/missingPlugins.ts, and plugin_geometry.py for the half of the
   *  same question the geometry engine answers.
   *
   *  Empty for a plugin that adds no feature of its own, which is most of them:
   *  a panel, a device, a printer connection all leave the document alone. */
  featureTypes: string[];
}

export type ParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; why: string };

// `Publisher.Name`, or a bare name for the ones that predate the convention.
//
// TWO HALVES because the id is a global name in a space anybody may publish
// into. Without a publisher segment the first two people to write an exporter
// both call it `exporter`, and the second one installs over the first.
//
// AND IT IS A DIRECTORY NAME, which is what the rest of this pattern is about.
// Every segment must start with an ASCII letter, so `.`, `..`, `.ssh` and
// `.staging-x` cannot be spelled at all, not as a defence in depth but as the
// only defence, since a traversal here would be a path join in Rust. ASCII
// only, so a homograph cannot make two ids that read identically. And no case
// rule, because the check that matters is not one a regex can make: Windows
// treats `Foo.Bar` and `foo.bar` as one directory and Linux does not, so
// `sameId()` below compares them the way the worst filesystem would.
const SEGMENT = "[A-Za-z][A-Za-z0-9-]{0,30}";
const ID = new RegExp(`^${SEGMENT}(\\.${SEGMENT})?$`);
// A hostname, or a leading-dot suffix that stands for one level of subdomain.
// No scheme, no path, no wildcard in the middle: a host allowlist that can
// express `*.anything.com` is not much of an allowlist.
const HOST = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Whether two ids name the same plugin ON EVERY PLATFORM THIS RUNS ON.
 *
 *  Not `a === b`, and the difference is a real bug rather than a hypothetical
 *  one. An id becomes a directory under the plugins root. macOS and Windows
 *  would hand `Someone.Tool` and `someone.tool` the same directory; Linux would
 *  hand them two. So a plugin could be installed twice on one machine and
 *  overwrite its neighbour on another, and the second is the one that matters:
 *  it is an install that replaces somebody else's plugin without either of them
 *  being asked.
 *
 *  Resolved by treating them as equal everywhere, which is the strictest of the
 *  two readings and therefore the only safe one to standardise on. */
export function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

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

  if (r.enabledByDefault !== undefined && typeof r.enabledByDefault !== "boolean") {
    return { ok: false, why: "enabledByDefault must be true or false" };
  }

  // Not run through the id pattern. These are names from BEFORE the convention,
  // which is what they are for, and a plugin whose old name would fail today's
  // check is exactly the plugin whose stored setting most needs finding.
  const formerRaw = r.formerIds === undefined ? [] : r.formerIds;
  if (!Array.isArray(formerRaw)) return { ok: false, why: "formerIds must be a list" };
  const formerIds: string[] = [];
  for (const f of formerRaw) {
    if (typeof f !== "string" || !f) {
      return { ok: false, why: `not a former id: ${JSON.stringify(f)}` };
    }
    if (f === id) return { ok: false, why: "formerIds repeats the current id" };
    formerIds.push(f);
  }

  // Not run through the id pattern either: a feature type is a document token
  // ("press-pull"), not a plugin id, and the format has never constrained it
  // beyond being a non-empty string.
  const typesRaw = r.featureTypes === undefined ? [] : r.featureTypes;
  if (!Array.isArray(typesRaw)) return { ok: false, why: "featureTypes must be a list" };
  const featureTypes: string[] = [];
  for (const t of typesRaw) {
    if (typeof t !== "string" || !t) {
      return { ok: false, why: `not a feature type: ${JSON.stringify(t)}` };
    }
    if (featureTypes.includes(t)) {
      return { ok: false, why: `featureTypes repeats ${JSON.stringify(t)}` };
    }
    featureTypes.push(t);
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
      enabledByDefault: r.enabledByDefault !== false,
      formerIds,
      featureTypes,
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
    case "builtin":
      // The bluntest of the four, deliberately. Everything else on this screen
      // reads like a permission, and for a built-in it is a description. The
      // sentence exists so that difference cannot be missed by someone who
      // learned what the screen means from the other entries.
      return "Part of FundaCAD itself. The list above is what it uses, not a limit on it, and turning it off stops it running.";
    case "process":
      return "Runs as a normal program on your computer. The list above is what it reaches through FundaCAD, not a cage around it, so install it only if you trust where it came from.";
    case "panel":
      return "Runs inside the window with no network and no access to your files, so the list above is all it can do.";
    case "compute":
      return "Runs as an isolated calculation with no network and no access to your files, so the list above is all it can do.";
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
