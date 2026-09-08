// Where plugins come from, and the door to the side that installs them.
//
// THREE WAYS IN, and they differ only in where the manifest is read from.
//
//   1. The suggested ones, listed below and compiled into the build. Their
//      manifests are known before anything is fetched, so there is nothing to
//      download in order to decide.
//   2. A URL the user gives. The only account of what the bundle wants is
//      inside the bundle, so it is fetched and unpacked to be read, and only
//      then described on a screen.
//   3. A zip the user already has, read the same way.
//
// There is no catalogue fetched from anywhere and there never will be. A
// document whose only job is to be believed is a document that can lie, and the
// suggestions below cost nothing to carry in the build.
//
// WHAT IS NOT DECIDED HERE: whether a plugin may do what it asks. That is
// ./manifest.ts, and every one of the three routes goes through it. The entries
// below are written as untrusted JSON and parsed by the same `parseManifest`
// that parses a stranger's `plugin.json`, so a suggested entry that could not
// be installed cannot be offered either. The test that matters asserts exactly
// that.
//
// AND WHAT "OFFICIAL" MEANS: that we published it, and nothing else. It is a
// label on a row, decided in Rust from the URL the bytes actually came from. It
// buys a plugin no permission, skips no screen, and a bundle claiming it in its
// own manifest is ignored, because a bundle claiming to be ours is precisely
// the one that must not be believed for saying so.

import {
  parseManifest,
  promiseOf,
  type PluginManifest,
} from "./manifest";
import type { DocumentStore } from "../document/store";
import type { RunOutcome } from "./runner/host";

/** Where this project's own bundles are published. Mirrors BUNDLE_PREFIX in
 *  src-tauri/src/plugins/bundle.rs; this copy only builds the URLs, and that
 *  copy decides which of them get the label. */
const RELEASES = "https://github.com/Paraxdev/fundacad/releases/download/";

export interface OfficialPlugin {
  manifest: PluginManifest;
  /** the release the asset hangs off. "beta" is the rolling one the installers
   *  and the update feed already use. */
  tag: string;
  /** the asset's file name on that release */
  asset: string;
  /** the URL the download will be attempted from */
  url: string;
}

/** Written as plain data, on purpose: this is the same shape a third-party
 *  bundle will arrive in, so it goes through the same parser and gets the same
 *  refusals. A built-in entry is not privileged. */
const OFFICIAL_RAW: { tag: string; asset: string; manifest: unknown }[] = [
  {
    tag: "beta",
    asset: "plugin-mcp.zip",
    manifest: {
      id: "mcp",
      name: "MCP server",
      version: "0.1.0",
      kind: "process",
      summary: "Lets an AI assistant build, measure and edit models here.",
      // Not process.spawn, and the distinction is the point of having a closed
      // vocabulary. The server does start a second process when it works on
      // its own copy, but that process is the geometry engine this app already
      // ships, started from a path this app hands it. "Start other programs on
      // your computer" would be a true sentence describing something else.
      //
      // Not network either: it speaks to the engine over loopback, and putting
      // "connect to 127.0.0.1" on a consent screen teaches people to skim it.
      grants: [
        "document.read",
        "document.write",
        "geometry.build",
        "files.read",
        "files.write",
      ],
    },
  },
];

/** The offered plugins, refusing to offer one whose own manifest is invalid.
 *
 *  Throws rather than skipping. A built-in entry that does not parse is a
 *  mistake in this file, not a condition to degrade around, and a silent skip
 *  would ship an app whose plugin list is quietly one short. */
export function officialPlugins(): OfficialPlugin[] {
  return OFFICIAL_RAW.map((entry) => {
    const parsed = parseManifest(entry.manifest);
    if (!parsed.ok) {
      throw new Error(`built-in plugin entry is not installable: ${parsed.why}`);
    }
    return {
      manifest: parsed.manifest,
      tag: entry.tag,
      asset: entry.asset,
      url: `${RELEASES}${entry.tag}/${entry.asset}`,
    };
  });
}

// ---------------------------------------------------------------------------
// what is on disk
// ---------------------------------------------------------------------------

/** The Rust record, as it arrives. `consented` is what the bundle actually
 *  declared; `promise` is `promiseOf()` of what the screen showed. */
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
}

export interface PythonRuntime {
  python: string;
  pythonpath: string | null;
  sidecarDir: string;
}

const isTauri = () => "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(cmd, args);
}

/** Installed plugins, or none at all in a plain browser session. Nothing here
 *  can be installed outside the app, so an empty list is the honest answer
 *  rather than an error to render. */
export async function installedPlugins(): Promise<InstalledPlugin[]> {
  if (!isTauri()) return [];
  return await call<InstalledPlugin[]>("plugin_list");
}

/** Download and install, having already shown what it asks for.
 *
 *  `promise` and the grant set are passed down so the far side can hold the
 *  bundle to them. They are not advice: an unpacked `plugin.json` that asks for
 *  more than this is refused there and never becomes installed. */
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

/** A manifest to describe an installed plugin with, or null if the record does
 *  not parse into one.
 *
 *  What is recorded on disk is the PROMISE, not the presentation: the grants,
 *  the hosts, the kind and the version, because those are what was agreed to
 *  and what has to be checked again. A name and a one-line summary are not part
 *  of that and are not stored, so they come from the suggested entry when the
 *  plugin is one of ours and from the id when it is not.
 *
 *  Null rather than a best guess when the record will not parse. A row that
 *  cannot be described accurately is a row that must not be described
 *  reassuringly, and the screen shows it plainly instead. */
export function installedManifest(rec: InstalledPlugin): PluginManifest | null {
  const suggested = OFFICIAL_RAW.find((e) => {
    const parsed = parseManifest(e.manifest);
    return parsed.ok && parsed.manifest.id === rec.id;
  });
  const known = suggested ? parseManifest(suggested.manifest) : null;
  const parsed = parseManifest({
    id: rec.id,
    name: known?.ok ? known.manifest.name : rec.id,
    version: rec.version,
    kind: rec.consented.kind,
    summary: known?.ok ? known.manifest.summary : "",
    grants: rec.consented.grants,
    hosts: rec.consented.hosts,
  });
  return parsed.ok ? parsed.manifest : null;
}

/** Read an installed plugin's entry point.
 *
 *  The far side decides the file name from what the plugin declared, so this
 *  is not a file reader with a plugin id attached to it. */
export async function pluginEntry(id: string): Promise<string> {
  return await call<string>("plugin_entry", { id });
}

/** Run an installed compute plugin against the document that is open.
 *
 *  The pieces are deliberately assembled here and nowhere else: the code comes
 *  off disk, the grants come off the INSTALLED RECORD rather than from anything
 *  the plugin says now, and the host is the app. A caller cannot widen a plugin
 *  by calling this differently, because there is nothing to pass.
 *
 *  The sandbox arrives by dynamic import, so a build where nobody runs a plugin
 *  never loads a Worker runner. */
export async function runComputePlugin(
  rec: InstalledPlugin,
  store: DocumentStore,
  featureTypes?: () => string[],
): Promise<RunOutcome> {
  if (rec.consented.kind !== "compute") {
    throw new Error(`${rec.id} is a ${rec.consented.kind} plugin, which is not run here`);
  }
  const manifest = installedManifest(rec);
  if (!manifest) throw new Error(`${rec.id} has no record this app can read`);

  const [{ spawnAndRun }, { appHost }] = await Promise.all([
    import("./runner/spawn"),
    import("./broker/appHost"),
  ]);
  return await spawnAndRun({
    plugin: manifest.id,
    grants: manifest.grants,
    host: appHost(featureTypes ? { store, featureTypes } : { store }),
    source: await pluginEntry(rec.id),
  });
}

export async function removePlugin(id: string): Promise<void> {
  await call<void>("plugin_remove", { id });
}

/** The interpreter and packages the app already installed, for a plugin that
 *  something else has to launch. */
export async function pythonRuntime(): Promise<PythonRuntime> {
  return await call<PythonRuntime>("plugin_python");
}

// ---------------------------------------------------------------------------
// a bundle nobody has seen yet
// ---------------------------------------------------------------------------

/** A bundle that has been read but not installed.
 *
 *  This exists because of an ordering problem with only one honest answer. The
 *  screen has to say what a plugin asks for before it is installed, and for a
 *  bundle from a URL nobody has seen, the only account of what it asks for is
 *  inside it. So it is fetched, unpacked in a scratch directory, read, and
 *  thrown away again. Fetching is not running: nothing executes, nothing is
 *  left on disk, and nothing is recorded.
 *
 *  `sha256` is what came back from that read, and it is passed back in as a pin
 *  when the install actually happens. Without it the install would be a second
 *  fetch of something that could have changed in between, and the screen would
 *  have described one bundle while another was installed. */
export interface Candidate {
  manifest: PluginManifest;
  /** the digest of the bytes that were read, pinned for the install */
  sha256: string;
  /** the URL or the path, as given */
  source: string;
  from: "url" | "file";
  /** whether we published it. A label, never a permission. */
  official: boolean;
  /** where it came from, as one short phrase for the screen */
  origin: string;
}

/** What `plugin_inspect_*` hands back. `manifest` is untrusted: it is the
 *  bundle's own file, verbatim. */
export interface RawInspected {
  manifest: unknown;
  sha256: string;
  source: string;
  official: boolean;
}

/** The host, for a URL, or a plain phrase for a local file.
 *
 *  Shown on the screen that asks, so it is the answer to "who am I trusting"
 *  rather than a tidied-up URL. Rust has already refused anything whose
 *  authority does not mean what it reads, so the host here is the host that
 *  will answer. */
export function originOf(source: string, from: "url" | "file"): string {
  if (from === "file") return "a file on this computer";
  try {
    return new URL(source).host;
  } catch {
    // Unreachable in practice: Rust refused it long before this. A thrown
    // exception while building a sentence about safety would be a poor way to
    // find that out, so it degrades to the least reassuring true thing.
    return "an unknown place";
  }
}

/** Turn what came back from a read into something the screen can describe, or
 *  refuse it. Exported and pure, because this is where a stranger's manifest
 *  meets this app's parser and that is the part worth testing without a Tauri
 *  window around it. */
export function candidateFrom(raw: RawInspected, from: "url" | "file"): Candidate {
  const parsed = parseManifest(raw.manifest);
  if (!parsed.ok) {
    // Refused here rather than shown with the bad parts hidden. A manifest this
    // app cannot fully read is one it cannot describe, and a screen that
    // describes a plugin incompletely is worse than no screen.
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

/** Install what was read and agreed to.
 *
 *  The digest goes back down as a pin, so a bundle whose bytes moved between
 *  the screen and this call is refused rather than quietly installed under the
 *  old description. The grants go down as well, and are compared against the
 *  bundle's own manifest on the far side: this call is a statement of what was
 *  agreed, not an instruction to trust it. */
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
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Plugin bundle", extensions: ["zip"] }],
  });
  return typeof picked === "string" ? picked : null;
}

// ---------------------------------------------------------------------------
// launching the MCP plugin, which is not this app's job
// ---------------------------------------------------------------------------

export interface LaunchConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Windows paths keep backslashes, everything else keeps slashes. Written out
 *  rather than imported: this runs in the webview, which has no path module,
 *  and the only input is a path the app itself produced. */
function join(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** How to start the installed MCP server: the command line an MCP host needs.
 *
 *  Pure, and separate from everything above, because this is the part people
 *  copy into another program's settings and the part worth testing. The app
 *  never runs this itself; the host does.
 *
 *  PYTHONPATH carries the bundled packages. `server.py` puts its own directory
 *  on the path already, so the plugin's own modules need no entry.
 *  FUNDACAD_SIDECAR_DIR is how a plugin living under the app data directory
 *  finds the geometry engine's sources, which are in the app's resources and
 *  nowhere near it. */
export function mcpLaunch(dir: string, runtime: PythonRuntime): LaunchConfig {
  const env: Record<string, string> = {};
  if (runtime.pythonpath) env.PYTHONPATH = runtime.pythonpath;
  if (runtime.sidecarDir) env.FUNDACAD_SIDECAR_DIR = runtime.sidecarDir;
  return { command: runtime.python, args: [join(dir, "server.py")], env };
}

/** The same thing as the block an MCP host expects in its config file. */
export function mcpConfigJson(dir: string, runtime: PythonRuntime): string {
  return JSON.stringify({ mcpServers: { fundacad: mcpLaunch(dir, runtime) } }, null, 2);
}
