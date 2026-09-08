// The part of the op table only the operating system can answer.
//
// Four ops reach past the window: three about files, one about the build. They
// go through the SAME broker, checked against the SAME grants, as everything
// else. That is the whole design decision here and it is worth stating plainly,
// because the tempting shape is a second channel, a `native` object handed to
// the plugin beside `app`, and a second channel is a second permission system
// to keep in step with the first. There is one door.
//
// WHAT MAKES THE FILE OPS SAFE IS NOT A RULE ABOUT DIRECTORIES. A plugin never
// names a file. It asks, a native dialog opens, and what comes back is a
// HANDLE: an opaque token, a file name, a length. To read the file it hands the
// handle back. So "which files may this plugin read" answers itself: the ones
// somebody picked, this session, for this plugin. No allowlist to configure, no
// sandbox root to get wrong, and nothing to widen later.
//
// A PATH NEVER CROSSES. Not to the plugin and not even into the window: the
// handle table lives in Rust (src-tauri/src/plugins/handed.rs), so what a
// plugin could learn about somebody's disk is a file name they chose to show
// it.
//
// AND THE SIX OPS THIS DOES NOT ADD. `doc_open` and `doc_save` still refuse,
// and that is on purpose rather than unfinished: their signatures take a path,
// which is exactly the thing a plugin may not have. What a plugin does instead
// is compose, `file_pick` then `file_read` then `doc_set` to open and `doc_get`
// then `file_write` to save, which is the same work with the person in it. The
// alternative was to give those two ops a different meaning for a compute
// plugin than they have over MCP, and one vocabulary that means two things is
// worse than one vocabulary with a gap in it.

import type { Op } from "./ops";

/** A file the person has handed to this plugin. The `handle` is the only way
 *  to name it again, and it is meaningless to any other plugin. */
export interface PickedFile {
  handle: string;
  /** the file name, never the directory */
  name: string;
  len: number;
}

/** A file's contents. Exactly one of `text` and `base64` is set: text when the
 *  bytes are valid UTF-8, which covers JSON, CSV, SVG, STEP and G-code, and
 *  base64 when they are not, which covers STL and 3MF. */
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

/** What the ops in this file need from the outside world.
 *
 *  An interface rather than a direct `invoke`, so that a test can serve these
 *  without a desktop app and so that `appHost` has one thing to be handed
 *  rather than four. */
export interface NativeBridge {
  pick(opts: {
    plugin: string;
    purpose: string;
    extensions: string[];
  }): Promise<PickedFile | null>;
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

/** The ops this bridge serves. Exported so `appHost` can route by membership
 *  rather than by a second copy of the list, and so a test can assert that the
 *  set has not quietly grown. */
export const NATIVE_OPS = ["file_pick", "file_read", "file_write", "app_info"] as const;

export type NativeOp = (typeof NATIVE_OPS)[number];

const NATIVE_SET: ReadonlySet<string> = new Set<string>(NATIVE_OPS);

export function isNativeOp(op: Op): op is NativeOp {
  return NATIVE_SET.has(op);
}

/** The real bridge, over Tauri's IPC.
 *
 *  Imported lazily by the caller, never at module load: this module is reached
 *  from the plugin host, and the plugin host is reached from a browser session
 *  that has no `invoke` at all. */
export function tauriNative(): NativeBridge {
  const call = async <T>(cmd: string, args: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  };
  return {
    pick: (o) => call<PickedFile | null>("plugin_file_pick", { ...o }),
    read: (o) => call<FileBody>("plugin_file_read", { ...o }),
    // `base64Body`, not `base64`: the Rust parameter is named that way because
    // `base64` is the crate, and a mismatched argument name is an invoke that
    // fails with an unhelpful message about a missing field.
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
