// The grant vocabulary and how it is worded for the person deciding. Pure and Vue-free. An unknown grant is refused,
// and consent is recorded against `promiseOf()`, so a version asking for more has to ask again.

/** Everything a plugin can ask for. Closed set, deliberately small. */
export const GRANTS = [
  "document.read",
  "document.write",
  "document.history",
  "geometry.build",
  "files.read",
  "files.write",
  "network",
  "network.local",
  "device.input",
  "input.remap",
  "ui.panel",
  "process.spawn",
] as const;

export type Grant = (typeof GRANTS)[number];

/** Where the code runs, deciding how much of the sandbox is the OS's word and how much is ours. `builtin` ships inside
 *  the app with its own reach and nothing sandboxes it, so it must never borrow the language of enforcement. */
export const PLUGIN_KINDS = ["builtin", "process", "panel", "compute"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

interface GrantCopy {
  /** shown under "It can" */
  can: string;
  /** shown under "It cannot" when the plugin did NOT ask for it. Absent where the line teaches nothing, like "cannot
   *  add a panel". */
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
  // `can` is filled in with the hosts: "can use the internet" is not a decision anybody can make.
  network: { can: "Connect to the internet", cannot: "Use the internet" },
  // No host list: reach is bounded to private and link-local addresses (src-tauri/src/plugins/localnet.rs).
  "network.local": {
    can: "Talk to devices on your local network",
    cannot: "Reach devices on your local network",
  },
  "device.input": {
    can: "Read the 3D mouse or other input device you have plugged in",
    cannot: "Read any device you plug in",
  },
  "input.remap": {
    can: "Change what your mouse buttons and keys do",
    cannot: "Change what your mouse buttons and keys do",
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
  /** Whether a capability that ships with the app runs before anybody said anything. Outside `promiseOf()`: a
   *  preference, never a permission. Defaults to true, and for a downloaded bundle the install is the answer. */
  enabledByDefault: boolean;
  /** Old ids, so a stored on/off answer survives a rename. In the plugin's manifest, not an app table, so the app never
   *  knows a plugin's history. Read forward only: the new id is saved on the next change. */
  formerIds: string[];
  /** Feature `type` values this plugin owns. Declared, not inferred, so they can be read while the plugin is not
   *  running, to name it in the missing plugin warning (document/missingPlugins.ts). Empty for most plugins. */
  featureTypes: string[];
  /** The bundle path of the WebAssembly component the Rust engine runs, "" for
   *  a plugin with no geometry or a bundle built for the Python engine only. */
  geometryWasm: string;
}

export type ParseResult = { ok: true; manifest: PluginManifest } | { ok: false; why: string };

// `Publisher.Name`, two halves so two publishers' `exporter` cannot collide. It is a directory name: every segment
// starts with an ASCII letter, so `.`, `..` and `.ssh` cannot be spelled. Case is left to `sameId()`.
const SEGMENT = "[A-Za-z][A-Za-z0-9-]{0,30}";
const ID = new RegExp(`^${SEGMENT}(\\.${SEGMENT})?$`);
// A hostname, or a leading-dot suffix for one subdomain level. No scheme, no path, no wildcard in the middle.
const HOST = /^\.?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Case-insensitive, because an id is a directory and Windows and macOS give `Someone.Tool` and `someone.tool` the same
 *  one, so an install could replace somebody else's plugin. The strictest reading is the only safe one. */
export function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const isGrant = (v: unknown): v is Grant => (GRANTS as readonly unknown[]).includes(v);
const isKind = (v: unknown): v is PluginKind => (PLUGIN_KINDS as readonly unknown[]).includes(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Every rejection names its reason, so a publisher knows which line to fix. */
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

  // Not run through the id pattern: these predate the convention, and those most need their stored setting found.
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

  // Not the id pattern either: a feature type is a document token ("press-pull"), only required to be non-empty.
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

  // Both directions are errors: a permission and its scope arrive together, or the screen shows what is not enforced.
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
      geometryWasm: str(r.geometryWasm),
    },
  };
}

/** The "cannot" list is what tells a modest plugin from a greedy one. Both lists come off one table, so neither goes
 *  stale. */
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

/** Until each platform's sandbox is wired up, a process plugin's grants describe only what it reaches through FundaCAD,
 *  and the install screen must say so. */
export function sandboxNote(kind: PluginKind): string {
  switch (kind) {
    case "builtin":
      // The bluntest of the four on purpose: for a built-in the list is a description, not a permission.
      return "Part of FundaCAD itself. The list above is what it uses, not a limit on it, and turning it off stops it running.";
    case "process":
      return "Runs as a normal program on your computer. The list above is what it reaches through FundaCAD, not a cage around it, so install it only if you trust where it came from.";
    case "panel":
      return "Runs inside the window with no network and no access to your files, so the list above is all it can do.";
    case "compute":
      return "Runs as an isolated calculation with no network and no access to your files, so the list above is all it can do.";
  }
}

/** Sorted, so the order a publisher wrote the list in cannot re-prompt for an unchanged promise. Readable rather than
 *  hashed, because it is the record of what someone agreed to. */
export function promiseOf(manifest: PluginManifest): string {
  const grants = [...manifest.grants].sort().join(",");
  const hosts = [...manifest.hosts].sort().join(",");
  return hosts ? `${manifest.kind}|${grants}|${hosts}` : `${manifest.kind}|${grants}`;
}

/** Same promise or a strictly smaller one lets an update install without asking again. */
export function promiseCovers(consented: PluginManifest, incoming: PluginManifest): boolean {
  if (consented.kind !== incoming.kind) return false;
  const had = new Set<string>(consented.grants);
  const hadHosts = new Set<string>(consented.hosts);
  return incoming.grants.every((g) => had.has(g)) && incoming.hosts.every((h) => hadHosts.has(h));
}
