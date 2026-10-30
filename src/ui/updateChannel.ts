// Where this install looks for updates. Stable and Beta are one product, FundaCAD, so picking one only moves the
// endpoint of the next check. Development is FundaCAD Dev, a separate install, so it is never stored here.

import { productName } from "../app/channel";
import { REPO_URL } from "./reportText";
import { readSetting } from "./storedSetting";

export type UpdateChannel = "stable" | "beta" | "development";

export const UPDATE_CHANNELS: readonly { id: UpdateChannel; label: string }[] = [
  { id: "stable", label: "Stable" },
  { id: "beta", label: "Beta" },
  { id: "development", label: "Development" },
];

const CHANNEL_KEY = "fundacad.updates.channel";
const STABLE_KEY = "fundacad.updates.stableSeen";

export function asUpdateChannel(v: unknown): UpdateChannel | null {
  return v === "stable" || v === "beta" || v === "development" ? v : null;
}

/** A stable build carries its version tag, v1.1.0, as the release. */
export function channelOfTag(tag: string): UpdateChannel {
  return tag === "beta" || tag === "development" ? tag : "stable";
}

export function channelAction(build: UpdateChannel, picked: UpdateChannel): "switch" | "beside" {
  return (build === "development") === (picked === "development") ? "switch" : "beside";
}

export function besideTitle(picked: UpdateChannel): string {
  return `Install ${productName(picked)} beside this app`;
}

/** No stable release has a tag of its own yet, so Stable opens the latest. */
export function releasePageUrl(ch: UpdateChannel): string {
  return ch === "stable" ? `${REPO_URL}/releases/latest` : `${REPO_URL}/releases/tag/${ch}`;
}

export function channelOptions(
  build: UpdateChannel,
  seen: boolean,
): { value: UpdateChannel; label: string; hint?: string; disabled?: boolean }[] {
  return UPDATE_CHANNELS.map(({ id, label }) => {
    if (id === "stable" && !seen) return { value: id, label, hint: "No stable release yet", disabled: true };
    if (channelAction(build, id) === "beside")
      return { value: id, label, hint: `Installs ${productName(id)} beside this app` };
    return { value: id, label };
  });
}

// A guess until syncBuildChannel hears from Rust, which reads the build channel from this build's updater endpoint.
let build = channelOfTag((import.meta.env.VITE_FUNDACAD_RELEASE as string | undefined) || "beta");
let stableRecorded = readSetting(STABLE_KEY) === "yes";
let picked = storedPick();
const listeners = new Set<() => void>();

function storedPick(): UpdateChannel {
  const stored = asUpdateChannel(readSetting(CHANNEL_KEY));
  if (!stored || channelAction(build, stored) === "beside") return build;
  return stored === "stable" && !stableReleaseSeen() ? build : stored;
}

function notify() {
  for (const fn of listeners) fn();
}

function store(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* no storage: the change lasts the session */
  }
}

export const buildChannel = (): UpdateChannel => build;
export const updateChannel = (): UpdateChannel => picked;
export function stableReleaseSeen(): boolean {
  return build === "stable" || stableRecorded;
}

/** A build made without VITE_FUNDACAD_RELEASE guesses beta, while update_check goes by the updater config. */
export function adoptBuildChannel(next: UpdateChannel) {
  if (next === build) return;
  build = next;
  picked = storedPick();
  notify();
}

let buildSync: Promise<void> | undefined;

export function syncBuildChannel(): Promise<void> {
  buildSync ??= import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<string | null>("update_build_channel"))
    .then((ch) => {
      const known = asUpdateChannel(ch);
      if (known) adoptBuildChannel(known);
    })
    .catch(() => {});
  return buildSync;
}

/** False, and nothing stored, for a channel of the other product: that one installs beside this app. */
export function setUpdateChannel(next: UpdateChannel): boolean {
  if (channelAction(build, next) === "beside") return false;
  if (next === picked) return true;
  picked = next;
  store(CHANNEL_KEY, next);
  notify();
  return true;
}

/** A stable release never goes away, so a later check that misses it leaves it seen. */
export function recordStableSeen(seen: boolean) {
  if (!seen || stableReleaseSeen()) return;
  stableRecorded = true;
  store(STABLE_KEY, "yes");
  notify();
}

export function onUpdateChannelChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
