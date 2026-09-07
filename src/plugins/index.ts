// The plugins this app knows how to install, and the door to the side that
// installs them.
//
// There is no catalogue fetched from anywhere. The official plugins are assets
// on this repository's own releases, and the list of them is right here, in the
// build. That means a plugin can only appear because a version of the app
// shipped offering it, the download URL is checked against the releases prefix
// in Rust rather than trusted from a file, and there is no served document
// whose only job is to be believed.
//
// What is NOT decided here: whether a plugin may do what it asks. That is
// ./manifest.ts, and this module goes through it like everyone else. The
// entries below are written as untrusted JSON and parsed by the same
// `parseManifest` that will parse the bundle's own `plugin.json` after the
// download, so a built-in entry that could not be installed cannot be offered
// either. The test that matters asserts exactly that.

import {
  parseManifest,
  promiseOf,
  type PluginManifest,
} from "./manifest";

/** Where every official bundle comes from. Mirrors BUNDLE_PREFIX in
 *  src-tauri/src/plugins/bundle.rs, which is the copy that is enforced; this
 *  one only builds the URL that copy will check. */
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

export async function removePlugin(id: string): Promise<void> {
  await call<void>("plugin_remove", { id });
}

/** The interpreter and packages the app already installed, for a plugin that
 *  something else has to launch. */
export async function pythonRuntime(): Promise<PythonRuntime> {
  return await call<PythonRuntime>("plugin_python");
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
