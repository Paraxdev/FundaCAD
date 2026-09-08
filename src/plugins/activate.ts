// Starting and stopping the plugins that are installed.
//
// One place where the app says "run whatever is active" instead of naming the
// things it runs. That sentence is the whole point of this file: nothing in
// app/ imports the 3D mouse or the printer, and adding a capability is adding a
// directory under plugins/ rather than an edit to anything here. This file
// names no plugin at all.
//
// ACTIVE MEANS INSTALLED AND NOT SWITCHED OFF. Not a build-time list: what the
// app ships with is nothing, and every plugin including the ones written in
// this repository arrives as a zip from a release. The switch is the smaller of
// the two questions and it defaults to on, because installing something is
// already an answer to "do you want this".
//
// TWO SOURCES FOR A PLUGIN'S CODE, and the difference between them is the
// difference between a shipped build and a development one:
//
//   installed  the bundle's own `main.js`, read back through Rust (which is
//              where the origin rule is enforced) and evaluated by ./loader.ts.
//              This is what a real installation does, always.
//   dev        the plugin directory compiled straight into the dev bundle, so
//              an edit to a plugin is visible on reload rather than after a
//              package-publish-install round trip. `vite dev` only; see
//              ./devPlugins.ts for why the branch shape matters, and
//              scripts/check-no-plugin-code.mjs for the check that it holds.
//
// Removing one at runtime really does stop it. Each activate() returns its
// teardown, and this holds them so a removal can run the right one. A plugin
// that could only be stopped by restarting would be an uninstall that lies for
// as long as the session lasts.

import { installedIds, onInstalledChange, pluginCode, refreshInstalled } from "./index";
import { onPluginChange, pluginEnabled } from "./registry";
import { evaluatePlugin, hostModules, type PluginModule } from "./loader";
import type { Engine } from "../app/engine";

/** Whatever a plugin needs to do when it starts, and the undo for it. */
type Activator = (e: Engine) => Promise<() => void>;

/** Which plugins should be running, out of what is installed and what a
 *  development build compiled in.
 *
 *  Pure, exported, and tested directly. The two questions it answers are the
 *  whole policy of this file — is it here, and has it been switched off — and
 *  the alternative is testing them through a dynamic import of a glob that a
 *  test cannot stand in for. Sorted, so the order plugins start in does not
 *  depend on which set happened to name one first. */
export function activeIds(
  installed: Iterable<string>,
  dev: Iterable<string>,
  enabled: (id: string) => boolean,
): string[] {
  return [...new Set([...installed, ...dev])].filter(enabled).sort();
}

/** A module is startable if it exported the one thing this file calls.
 *
 *  Checked rather than asserted, because a bundle can carry any `main.js` at
 *  all, and the failure would otherwise be `m.activate is not a function` at a
 *  point where nothing says which plugin. */
function activatorOf(m: unknown): Activator | null {
  const fn = (m as { activate?: unknown } | null)?.activate;
  return typeof fn === "function" ? (fn as Activator) : null;
}

/** The plugins compiled into a development build: none at all in a shipped one.
 *
 *  The `import.meta.env.DEV` branch is what keeps them out of it. Vite replaces
 *  the expression with `false`, rollup drops the branch, and the dynamic import
 *  inside it goes too, taking ./devPlugins.ts and every plugin's code with it. */
async function devLoaders(): Promise<Record<string, () => Promise<unknown>>> {
  if (!import.meta.env.DEV) return {};
  return (await import("./devPlugins")).devLoaders;
}

/** A plugin's app-side module, or null when it has none to run.
 *
 *  INSTALLED FIRST, and never the other way round. The installed copy is the one
 *  somebody consented to and the one a release actually shipped; a development
 *  build that quietly preferred its own would be testing something nobody has. */
async function moduleFor(
  id: string,
  dev: Record<string, () => Promise<unknown>>,
): Promise<PluginModule | null> {
  const code = await pluginCode(id);
  if (code !== null) return evaluatePlugin(id, code, await hostModules());
  const load = dev[id];
  return load ? ((await load()) as PluginModule) : null;
}

/** Run the plugins that are installed, and keep doing so as that set changes.
 *
 *  Returns a teardown that stops everything and stops listening, which is what
 *  a test needs to leave no timers, listeners or device handles behind. */
export function activatePlugins(e: Engine): () => void {
  const running = new Map<string, () => void>();
  // Empty in a shipped build, and the plugin directories of this repository in
  // a development one.
  let dev: Record<string, () => Promise<unknown>> = {};
  // Loading is asynchronous, so a fast install-remove-install can otherwise land
  // a teardown before the thing it tears down exists. Recording the intent and
  // checking it again on the far side of the await is what keeps the last
  // instruction the winning one.
  const wanted = new Set<string>();

  const sync = () => {
    const on = new Set(activeIds(installedIds(), Object.keys(dev), pluginEnabled));
    for (const id of on) {
      if (wanted.has(id)) continue;
      wanted.add(id);
      void moduleFor(id, dev)
        .then((m) => {
          const activate = m && activatorOf(m);
          // A plugin with no app-side module is not an error: a process plugin
          // that contributes nothing to the window is a complete plugin.
          return activate ? activate(e) : () => {};
        })
        .then((stop) => {
          if (!wanted.has(id)) {
            stop(); // removed again while it was loading
            return;
          }
          running.set(id, stop);
        })
        .catch((err) => {
          wanted.delete(id);
          // Loud, but not fatal. A plugin that will not start is a feature
          // missing from the window, and a window that will not open is worse.
          // The console is where the reason has to be.
          console.error(`[plugins] ${id} could not start:`, err);
        });
    }
    for (const id of [...wanted]) {
      if (on.has(id)) continue;
      wanted.delete(id);
      running.get(id)?.();
      running.delete(id);
    }
  };

  sync();
  const offInstalled = onInstalledChange(sync);
  const offSwitch = onPluginChange(sync);
  // The dev set arrives a tick later (it is behind a dynamic import), so sync
  // again once it is known. In a shipped build this resolves to nothing and the
  // second sync is a no-op over an unchanged set.
  void devLoaders().then((loaders) => { dev = loaders; sync(); });
  // What is on disk is not known until it has been asked for, and asking is a
  // command round-trip. Kicked off here rather than at a call site, so nothing
  // has to remember that starting the plugins needs this first.
  void refreshInstalled();
  return () => {
    offInstalled();
    offSwitch();
    wanted.clear();
    for (const stop of running.values()) stop();
    running.clear();
  };
}
