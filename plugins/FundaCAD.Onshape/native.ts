// The app's generic native commands, typed for this plugin. None of them knows
// Onshape: an https request to a host the manifest names, and a secret in the
// operating system's credential store.

import { invoke } from "fundacad";
import type { Keys, WebRequest, WebResponse } from "./client";

export const PLUGIN_ID = "FundaCAD.Onshape";

export function webRequest(request: WebRequest): Promise<WebResponse> {
  return invoke("plugin_web_request", { plugin: PLUGIN_ID, request });
}

export function removeDownload(name: string): Promise<void> {
  return invoke("plugin_download_remove", { plugin: PLUGIN_ID, name });
}

const ACCESS = "access-key";
const SECRET = "secret-key";

export async function loadKeys(): Promise<Keys | null> {
  const access = await invoke<string | null>("plugin_secret_get", { plugin: PLUGIN_ID, name: ACCESS });
  const secret = await invoke<string | null>("plugin_secret_get", { plugin: PLUGIN_ID, name: SECRET });
  return access && secret ? { access, secret } : null;
}

export async function saveKeys(keys: Keys): Promise<void> {
  await invoke("plugin_secret_set", { plugin: PLUGIN_ID, name: ACCESS, value: keys.access });
  await invoke("plugin_secret_set", { plugin: PLUGIN_ID, name: SECRET, value: keys.secret });
}

export async function forgetKeys(): Promise<void> {
  await invoke("plugin_secret_delete", { plugin: PLUGIN_ID, name: ACCESS });
  await invoke("plugin_secret_delete", { plugin: PLUGIN_ID, name: SECRET });
}
