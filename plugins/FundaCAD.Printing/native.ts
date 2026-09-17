// The app's generic native commands, typed for this plugin. None of them knows
// what a printer or a slicer is: a request to a device on the local network, a
// file in this plugin's own data directory, a program started with arguments,
// and a file the person picked.

import { invoke } from "fundacad";

export const PLUGIN_ID = "FundaCAD.Printing";

export type LocalBody =
  | { kind: "text"; text: string; mime?: string }
  | { kind: "json"; value: unknown }
  | {
    kind: "form";
    parts: { name: string; text?: string; file?: string; filename?: string; mime?: string }[];
  };

export interface LocalRequest {
  method?: string;
  url: string;
  headers?: [string, string][];
  body?: LocalBody;
  timeoutMs?: number;
  binary?: boolean;
}

export interface LocalResponse {
  status: number;
  contentType: string | null;
  text: string | null;
  base64: string | null;
}

export function localRequest(request: LocalRequest): Promise<LocalResponse> {
  return invoke("plugin_local_request", { plugin: PLUGIN_ID, request });
}

export function dataRead(name: string): Promise<string | null> {
  return invoke("plugin_data_read", { plugin: PLUGIN_ID, name });
}

export function dataWrite(name: string, text: string): Promise<void> {
  return invoke("plugin_data_write", { plugin: PLUGIN_ID, name, text });
}

export function dataPath(name: string): Promise<string> {
  return invoke("plugin_data_path", { plugin: PLUGIN_ID, name });
}

/** Move a file this plugin's code kept under the app data directory before it
 *  had a directory of its own. Resolves to whether anything moved. */
export function dataAdopt(legacy: string, name: string): Promise<boolean> {
  return invoke("plugin_data_adopt", { plugin: PLUGIN_ID, legacy, name });
}

export interface SystemDirs {
  os: string;
  home: string | null;
  config: string | null;
  localData: string | null;
  programs: string[];
}

export function systemDirs(): Promise<SystemDirs> {
  return invoke("plugin_system_dirs");
}

/** Start the first of `programs` that exists, resolving to which one. */
export function launch(programs: string[], args: string[]): Promise<string> {
  return invoke("plugin_launch", { plugin: PLUGIN_ID, programs, args });
}

export interface PickedFile {
  handle: string;
  name: string;
  len: number;
}

export function pickFile(purpose: string, extensions: string[]): Promise<PickedFile | null> {
  return invoke("plugin_file_pick", { plugin: PLUGIN_ID, purpose, extensions });
}
