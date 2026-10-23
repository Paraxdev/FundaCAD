// Ops only the operating system can answer. They pass the same broker and grants as every other op, not a channel.
// A plugin never names a file: a dialog hands it an opaque handle, and the table lives in Rust (plugins/handed.rs).

import type { Op } from "./ops";

/** The `handle` is the only way to name the file again, and it is meaningless to any other plugin. */
export interface PickedFile {
  handle: string;
  /** the file name, never the directory */
  name: string;
  len: number;
}

/** Exactly one of `text` and `base64` is set: text for valid UTF-8 (JSON, CSV, SVG, STEP, machine code),
 *  base64 otherwise (STL, 3MF). */
export interface FileBody {
  name: string;
  len: number;
  text?: string;
  base64?: string;
}

export interface WroteFile {
  name: string;
  len: number;
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
}

/** An interface rather than a direct `invoke`, so a test can serve it without a desktop app. */
export interface NativeBridge {
  pick(opts: { plugin: string; purpose: string; extensions: string[] }): Promise<PickedFile | null>;
  read(opts: { plugin: string; handle: string }): Promise<FileBody>;
  write(opts: {
    plugin: string;
    purpose: string;
    suggested: string;
    text?: string;
    base64?: string;
  }): Promise<WroteFile | null>;
  info(): Promise<AppInfo>;
}

/** Exported so `appHost` routes by membership, and a test can assert the set has not quietly grown. */
export const NATIVE_OPS = ["file_pick", "file_read", "file_write", "app_info"] as const;

export type NativeOp = (typeof NATIVE_OPS)[number];

const NATIVE_SET: ReadonlySet<string> = new Set<string>(NATIVE_OPS);

export function isNativeOp(op: Op): op is NativeOp {
  return NATIVE_SET.has(op);
}

/** Imports Tauri lazily, because the plugin host is also reached from a browser session that has no `invoke`. */
export function tauriNative(): NativeBridge {
  const call = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  };
  return {
    pick: (o) => call<PickedFile | null>("plugin_file_pick", { ...o }),
    read: (o) => call<FileBody>("plugin_file_read", { ...o }),
    // `base64Body`, because `base64` is the crate's name on the Rust side. A mismatched name fails as a missing field.
    write: (o) =>
      call<WroteFile | null>("plugin_file_write", {
        plugin: o.plugin,
        purpose: o.purpose,
        suggested: o.suggested,
        text: o.text ?? null,
        base64Body: o.base64 ?? null,
      }),
    info: () => call<AppInfo>("plugin_app_info", {}),
  };
}
