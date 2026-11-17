// Where the user's own language files come from. The text is untrusted either way, the catalog checks every line.

import { DROP_IN_PREFIX, type DropInSource } from "./catalog";
import { isLanguageCode } from "./languages";

export const noDropIns: DropInSource = { kind: "none", list: async () => [], read: async () => null };

type DropInStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function browserDropIns(storage: DropInStorage): DropInSource {
  return {
    kind: "browser",
    async list() {
      const codes: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        const code = key?.startsWith(DROP_IN_PREFIX) ? key.slice(DROP_IN_PREFIX.length) : null;
        if (code !== null && isLanguageCode(code)) codes.push(code);
      }
      return codes.sort();
    },
    async read(code) {
      return isLanguageCode(code) ? storage.getItem(DROP_IN_PREFIX + code) : null;
    },
    async save(code, text) {
      if (!isLanguageCode(code)) throw new Error(`${code} is no language code`);
      storage.setItem(DROP_IN_PREFIX + code, text);
    },
    async remove(code) {
      if (isLanguageCode(code)) storage.removeItem(DROP_IN_PREFIX + code);
    },
  };
}

let core: Promise<typeof import("@tauri-apps/api/core")> | undefined;
const tauri = () => (core ??= import("@tauri-apps/api/core"));

// Rust (src-tauri/src/languages.rs) takes a language code, never a path, and refuses links and files over 256 KB.
export const folderDropIns: DropInSource = {
  kind: "folder",
  list: async () => (await tauri()).invoke<string[]>("language_files_list"),
  async read(code) {
    return isLanguageCode(code) ? (await tauri()).invoke<string | null>("language_file_read", { code }) : null;
  },
  open: async () => (await tauri()).invoke<void>("language_folder_open"),
};

// Safe mode reads no user file.
export function pickDropInSource(
  page: { __TAURI_INTERNALS__?: unknown; __FUNDACAD_SAFE_MODE__?: unknown } | undefined,
  storage: DropInStorage | null,
): DropInSource {
  if (!page || page.__FUNDACAD_SAFE_MODE__) return noDropIns;
  if ("__TAURI_INTERNALS__" in page) return folderDropIns;
  return storage ? browserDropIns(storage) : noDropIns;
}
