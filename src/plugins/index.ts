// Where plugins come from: this repository's manifests read at build time, a URL, or a zip, all through parseManifest.
// "Official" only means we published it, decided in Rust from the source URL; it buys no permission, skips no screen.

import { parseManifest, promiseOf, sameId, type PluginManifest } from "./manifest";
import { bundleAsset, shippedPlugins } from "./shipped";
import type { DocumentStore } from "../document/store";
import { toast } from "../ui/toast";
import type { RunOutcome } from "./runner/host";
import { nativeDialog } from "../io/nativeDialog";

/** Mirrors BUNDLE_PREFIX in src-tauri/src/plugins/bundle.rs. This copy only builds URLs, that one decides the label. */
const RELEASES = "https://github.com/Paraxdev/fundacad/releases/download/";

/** beta, the rolling development build, or a stable tag passed in VITE_FUNDACAD_RELEASE. Its bundles carry geometry
 *  components built from the same commit as the engine's plugin host. */
export const RELEASE_TAG: string = (import.meta.env.VITE_FUNDACAD_RELEASE as string | undefined) || "beta";

export interface OfficialPlugin {
  manifest: PluginManifest;
  tag: string;
  asset: string;
  url: string;
}

/** Every directory under plugins/, builtin included. The asset name comes from `bundleAsset`, as the packager's does,
 *  so this never expects a file the release does not carry. */
export function officialPlugins(tag: string = RELEASE_TAG): OfficialPlugin[] {
  return shippedPlugins().map(({ manifest }) => {
    const asset = bundleAsset(manifest.id);
    return {
      manifest,
      tag,
      asset,
      url: `${RELEASES}${tag}/${asset}`,
    };
  });
}

/** The Rust record. `consented` is what the bundle declared, `promise` is `promiseOf()` of what the screen showed. */
export interface InstalledPlugin {
  id: string;
  version: string;
  promise: string;
  source: string;
  sha256: string;
  installedAt: number;
  dir: string;
  consented: { kind: string; version: string; grants: string[]; hosts: string[] };
  /** whether `source` is one of this project's own release assets */
  official: boolean;
  /** whether the files on disk hold the component the Rust engine runs */
  component?: boolean;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(cmd, args);
}

/** Empty in a plain browser session, where nothing can be installed. */
export async function installedPlugins(): Promise<InstalledPlugin[]> {
  if (!isTauri()) return [];
  const list = await retire(await call<InstalledPlugin[]>("plugin_list"));
  installedGrantMap = new Map(list.map((r) => [r.id, r.consented?.grants ?? []]));
  noteInstalled(list.map((r) => r.id));
  return list;
}

/** Plugins whose job moved into the app, removed from disk on sight so a stale bundle cannot start its companion.
 *  FundaCAD.MCP was the Python MCP server, and the app ships fundacad-mcp now. */
export const RETIRED_PLUGINS: readonly { id: string; note: string }[] = [
  {
    id: "FundaCAD.MCP",
    note: "The MCP server is part of FundaCAD now, so its plugin was removed. Preferences, AI assistants has the new connection settings.",
  },
];

async function retire(list: InstalledPlugin[]): Promise<InstalledPlugin[]> {
  const kept: InstalledPlugin[] = [];
  for (const rec of list) {
    const retired = RETIRED_PLUGINS.find((r) => sameId(r.id, rec.id));
    if (!retired) {
      kept.push(rec);
      continue;
    }
    try {
      await call<void>("plugin_remove", { id: rec.id });
      toast(retired.note);
    } catch (err) {
      console.error(`[plugins] could not remove the retired ${rec.id}:`, err);
    }
  }
  return kept;
}

// `plugin_list` is async but ./activate.ts syncs synchronously, so the installed set is cached here with listeners,
// like ./registry.ts. Empty until the first refresh, so no companion starts for a plugin not yet known to be installed.

let installedIdSet: ReadonlySet<string> = new Set();
let installedGrantMap = new Map<string, readonly string[]>();

/** The grants an installed plugin was consented with, as of the last refresh. */
export function installedGrants(id: string): readonly string[] | undefined {
  return installedGrantMap.get(id);
}
const installedListeners = new Set<() => void>();

/** The ids on disk as of the last refresh. */
export function installedIds(): ReadonlySet<string> {
  return installedIdSet;
}

export function onInstalledChange(fn: () => void): () => void {
  installedListeners.add(fn);
  return () => installedListeners.delete(fn);
}

function noteInstalled(ids: string[]) {
  const next = new Set(ids);
  if (next.size === installedIdSet.size && [...next].every((id) => installedIdSet.has(id))) return;
  installedIdSet = next;
  for (const fn of installedListeners) fn();
}

/** Null in a browser session and for a plugin installed without an app-side module. Any other refusal is thrown on
 *  purpose, so "not from FundaCAD's own releases" reaches the person instead of a plugin that silently does nothing. */
export async function pluginCode(id: string): Promise<string | null> {
  if (!isTauri()) return null;
  const code = await call<string>("plugin_code", { id });
  return code.length ? code : null;
}

/** Called at startup and after anything that installs or removes, so nothing has to keep the cache in step. */
export async function refreshInstalled(): Promise<void> {
  try {
    await installedPlugins();
  } catch {
    // Not fatal: the plugins screen reports the failure when it draws the list.
  }
}

/** `promise` and the grants go down so Rust holds the bundle to them: a manifest asking for more is refused there. */
export async function installPlugin(plugin: OfficialPlugin): Promise<InstalledPlugin> {
  const { manifest } = plugin;
  return await call<InstalledPlugin>("plugin_install", {
    id: manifest.id,
    url: plugin.url,
    sha256: null,
    promise: promiseOf(manifest),
    expect: {
      kind: manifest.kind,
      version: manifest.version,
      grants: manifest.grants,
      hosts: manifest.hosts,
    },
  });
}

/** Disk holds only the promise (grants, hosts, kind, version). Name and summary come from our own manifest or the id.
 *  Null rather than a best guess when the record will not parse, so the screen shows it plainly. */
export function installedManifest(rec: InstalledPlugin): PluginManifest | null {
  // `sameId`, not `===`: ids that differ only in case are one directory on Windows and macOS.
  const known = shippedPlugins().find((p) => sameId(p.manifest.id, rec.id))?.manifest;
  const parsed = parseManifest({
    id: rec.id,
    name: known ? known.name : rec.id,
    version: rec.version,
    kind: rec.consented.kind,
    summary: known ? known.summary : "",
    grants: rec.consented.grants,
    hosts: rec.consented.hosts,
  });
  return parsed.ok ? parsed.manifest : null;
}

/** Rust picks the file name from what the plugin declared, so this is not a file reader with an id attached. */
export async function pluginEntry(id: string): Promise<string> {
  return await call<string>("plugin_entry", { id });
}

/** The grants come off the installed record, never from the plugin, and a caller has nothing to pass that could widen
 *  them. The sandbox is a dynamic import, so a build where nobody runs a plugin never loads a Worker runner. */
export async function runComputePlugin(
  rec: InstalledPlugin,
  store: DocumentStore,
  featureTypes?: () => string[],
): Promise<RunOutcome> {
  if (rec.consented.kind !== "compute") {
    throw new Error(`${rec.id} is a ${rec.consented.kind} plugin, which is not run here`);
  }
  // Before the runner modules load: a document closed meanwhile is not the one the run was started on.
  const session = store.session;
  const manifest = installedManifest(rec);
  if (!manifest) throw new Error(`${rec.id} has no record this app can read`);

  const [{ spawnAndRun }, { appHost }, { tauriNative }] = await Promise.all([
    import("./runner/spawn"),
    import("./broker/appHost"),
    import("./broker/native"),
  ]);
  return await spawnAndRun({
    plugin: manifest.id,
    grants: manifest.grants,
    host: appHost({
      store,
      session,
      // Files handed to this plugin are recorded against its id in Rust. Without it the file ops refuse.
      plugin: manifest.id,
      native: tauriNative(),
      ...(featureTypes ? { featureTypes } : {}),
    }),
    source: await pluginEntry(rec.id),
  });
}

export async function removePlugin(id: string): Promise<void> {
  await call<void>("plugin_remove", { id });
}

/** A bundle read but not installed: fetched, unpacked in a scratch directory, read and thrown away, never run, so the
 *  screen can say what it asks for. `sha256` pins the install to the bytes that were described. */
export interface Candidate {
  manifest: PluginManifest;
  sha256: string;
  /** the URL or the path, as given */
  source: string;
  from: "url" | "file";
  /** whether we published it. A label, never a permission. */
  official: boolean;
  /** where it came from, as one short phrase for the screen */
  origin: string;
}

/** What `plugin_inspect_*` hands back. `manifest` is untrusted, the bundle's own file verbatim. */
export interface RawInspected {
  manifest: unknown;
  sha256: string;
  source: string;
  official: boolean;
}

/** Answers "who am I trusting" on the install screen. Rust already refused any authority that does not mean what it
 *  reads. */
export function originOf(source: string, from: "url" | "file"): string {
  if (from === "file") return "a file on this computer";
  try {
    return new URL(source).host;
  } catch {
    // Unreachable, Rust refused it first. Degrades to the least reassuring true thing rather than throwing.
    return "an unknown place";
  }
}

/** Pure and exported: this is where a stranger's manifest meets the parser, worth testing without a Tauri window. */
export function candidateFrom(raw: RawInspected, from: "url" | "file"): Candidate {
  const parsed = parseManifest(raw.manifest);
  if (!parsed.ok) {
    // Refused rather than shown with the bad parts hidden: a manifest this app cannot fully read, it cannot describe.
    throw new Error(`that bundle is not installable: ${parsed.why}`);
  }
  return {
    manifest: parsed.manifest,
    sha256: raw.sha256,
    source: raw.source,
    from,
    official: raw.official,
    origin: originOf(raw.source, from),
  };
}

/** Read a bundle at a URL without installing it. */
export async function inspectUrl(url: string): Promise<Candidate> {
  return candidateFrom(await call<RawInspected>("plugin_inspect_url", { url }), "url");
}

/** Read a bundle the user already has, without installing it. */
export async function inspectFile(path: string): Promise<Candidate> {
  return candidateFrom(await call<RawInspected>("plugin_inspect_file", { path }), "file");
}

/** The digest pins the bytes the screen described, and Rust compares the grants against the bundle's own manifest:
 *  this states what was agreed, not an instruction to trust it. */
export async function installCandidate(c: Candidate): Promise<InstalledPlugin> {
  const { manifest } = c;
  const args = {
    id: manifest.id,
    sha256: c.sha256,
    promise: promiseOf(manifest),
    expect: {
      kind: manifest.kind,
      version: manifest.version,
      grants: manifest.grants,
      hosts: manifest.hosts,
    },
  };
  return c.from === "url"
    ? await call<InstalledPlugin>("plugin_install", { ...args, url: c.source })
    : await call<InstalledPlugin>("plugin_install_file", { ...args, path: c.source });
}

/** Ask for a bundle on disk. Resolves to null if the picker was dismissed. */
export async function pickBundle(): Promise<string | null> {
  const { open } = await nativeDialog();
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Plugin bundle", extensions: ["zip"] }],
  });
  return typeof picked === "string" ? picked : null;
}
