// Starts the installed plugins that are not switched off and stops removed ones. It names no plugin:
// a new capability is a directory under plugins/, never an edit here.

import { installedGrants, installedIds, onInstalledChange, pluginCode, refreshInstalled } from "./index";
import { setGrantLookup } from "./contrib";
import { shippedPlugins } from "./shipped";
import { onPluginChange, pluginEnabled } from "./registry";
import { evaluatePlugin, hostModules, type PluginModule } from "./loader";
import type { Engine } from "../app/engine";

type Activator = (e: Engine) => Promise<() => void>;

/** Sorted, so the start order does not depend on which source named a plugin first. */
export function activeIds(
  installed: Iterable<string>,
  dev: Iterable<string>,
  enabled: (id: string) => boolean,
): string[] {
  return [...new Set([...installed, ...dev])].filter(enabled).sort();
}

/** Checked, because a bundle can carry any main.js and `m.activate is not a function` would not say which plugin. */
function activatorOf(m: unknown): Activator | null {
  const fn = (m as { activate?: unknown } | null)?.activate;
  return typeof fn === "function" ? (fn as Activator) : null;
}

/** The DEV branch lets rollup drop this import, and with it devPlugins.ts and all plugin code, from a shipped build. */
async function devLoaders(): Promise<Record<string, () => Promise<unknown>>> {
  if (!import.meta.env.DEV) return {};
  return (await import("./devPlugins")).devLoaders;
}

/** The installed copy wins over the dev one: it is what somebody consented to and what a release shipped. */
async function moduleFor(id: string, dev: Record<string, () => Promise<unknown>>): Promise<PluginModule | null> {
  const code = await pluginCode(id);
  if (code !== null) return evaluatePlugin(id, code, await hostModules());
  const load = dev[id];
  return load ? ((await load()) as PluginModule) : null;
}

/** The teardown stops everything and stops listening, so a test leaves no timers, listeners or device handles. */
export function activatePlugins(e: Engine): () => void {
  setGrantLookup((id) => installedGrants(id) ?? shippedPlugins().find((p) => p.dir === id)?.manifest.grants);
  const running = new Map<string, () => void>();
  let dev: Record<string, () => Promise<unknown>> = {};
  // Loading is async, so a fast install, remove, install could tear down before the thing exists.
  // Checking the intent again after the await lets the last instruction win.
  const wanted = new Set<string>();

  const sync = () => {
    const on = new Set(activeIds(installedIds(), Object.keys(dev), pluginEnabled));
    for (const id of on) {
      if (wanted.has(id)) continue;
      wanted.add(id);
      void moduleFor(id, dev)
        .then((m) => {
          const activate = m && activatorOf(m);
          // No app-side module is fine: a process plugin may contribute nothing to the window.
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
          // Not fatal: a plugin that will not start must not keep the window from opening.
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
  // The dev set arrives a tick later behind a dynamic import, so sync again once it is known.
  void devLoaders().then((loaders) => {
    dev = loaders;
    sync();
  });
  // Started here so no call site has to remember that plugins need the installed list first.
  void refreshInstalled();
  return () => {
    offInstalled();
    offSwitch();
    wanted.clear();
    for (const stop of running.values()) stop();
    running.clear();
  };
}
