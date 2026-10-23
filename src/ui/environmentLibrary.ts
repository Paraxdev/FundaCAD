// The user's saved environments and their panoramas, in IndexedDB: one 2k panorama is about 8 MB, past what
// localStorage holds. Panoramas are kept by hash, so two saved looks share one file.

import type { EnvSettings } from "./renderPrefs";

export type EnvTable = "entries" | "hdrs";

export interface KvStore {
  get<T>(table: EnvTable, key: string): Promise<T | undefined>;
  put(table: EnvTable, key: string, value: unknown): Promise<void>;
  delete(table: EnvTable, key: string): Promise<void>;
  values<T>(table: EnvTable): Promise<T[]>;
}

export interface EnvEntry {
  id: string;
  name: string;
  settings: EnvSettings;
  /** A data: URL picture of the panorama, or a CSS background for a built in room. */
  thumb: string;
  created: number;
}

export interface StoredHdr {
  hash: string;
  name: string;
  width: number;
  height: number;
  /** A flat Radiance file at the stored size (viewport/hdrImage.ts encodeRgbe). */
  rgbe: Uint8Array;
}

export const MAX_ENV_NAME = 60;

export function memoryKv(): KvStore {
  const tables: Record<EnvTable, Map<string, unknown>> = { entries: new Map(), hdrs: new Map() };
  return {
    get: async <T>(t: EnvTable, k: string) => structuredClone(tables[t].get(k)) as T | undefined,
    put: async (t, k, v) => {
      tables[t].set(k, structuredClone(v));
    },
    delete: async (t, k) => {
      tables[t].delete(k);
    },
    values: async <T>(t: EnvTable) => [...tables[t].values()].map((v) => structuredClone(v) as T),
  };
}

export function indexedDbKv(name = "fundacad-environments"): KvStore {
  let opened: Promise<IDBDatabase> | null = null;
  const db = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        for (const t of ["entries", "hdrs"])
          if (!req.result.objectStoreNames.contains(t)) req.result.createObjectStore(t);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        opened = null;
        reject(req.error);
      };
    }));
  const run = async <T>(t: EnvTable, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T> => {
    const tx = (await db()).transaction(t, mode);
    const req = op(tx.objectStore(t));
    return new Promise<T>((resolve, reject) => {
      tx.oncomplete = () => resolve(req.result as T);
      tx.onerror = () => reject(tx.error ?? req.error);
      tx.onabort = () => reject(tx.error ?? new Error("The environment library write was cancelled."));
    });
  };
  return {
    get: (t, k) => run(t, "readonly", (s) => s.get(k)),
    put: async (t, k, v) => {
      await run(t, "readwrite", (s) => s.put(v, k));
    },
    delete: async (t, k) => {
      await run(t, "readwrite", (s) => s.delete(k));
    },
    values: (t) => run(t, "readonly", (s) => s.getAll()),
  };
}

export function cleanEnvName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_ENV_NAME).trim();
}

function uniqueName(want: string, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  if (!lower.has(want.toLowerCase())) return want;
  for (let i = 2; ; i++) {
    const next = `${want} ${i}`;
    if (!lower.has(next.toLowerCase())) return next;
  }
}

export interface EnvLibrary {
  list(): Promise<EnvEntry[]>;
  save(name: string, settings: EnvSettings, thumb: string): Promise<EnvEntry>;
  rename(id: string, name: string): Promise<EnvEntry | null>;
  /** Drops the entry, and its panorama when nothing else names it. */
  remove(id: string, inUse?: string | null): Promise<void>;
  putHdr(h: StoredHdr): Promise<void>;
  getHdr(hash: string): Promise<StoredHdr | null>;
}

const hashOf = (s: EnvSettings) => (s.environment.startsWith("hdr:") ? s.environment.slice(4) : null);

export function createEnvLibrary(kv: KvStore, opts: { now?: () => number; newId?: () => string } = {}): EnvLibrary {
  const now = opts.now ?? Date.now;
  const newId = opts.newId ?? (() => crypto.randomUUID().replace(/-/g, "").slice(0, 16));
  const list = async () =>
    (await kv.values<EnvEntry>("entries")).sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  const named = (name: string) => {
    const n = cleanEnvName(name);
    if (!n) throw new Error("A saved environment needs a name.");
    return n;
  };
  return {
    list,
    async save(name, settings, thumb) {
      const n = named(name);
      const all = await list();
      const entry: EnvEntry = {
        id: newId(),
        name: uniqueName(
          n,
          all.map((e) => e.name),
        ),
        settings: { ...settings },
        thumb,
        created: now(),
      };
      await kv.put("entries", entry.id, entry);
      return entry;
    },
    async rename(id, name) {
      const n = named(name);
      const all = await list();
      const entry = all.find((e) => e.id === id);
      if (!entry) return null;
      const next = {
        ...entry,
        name: uniqueName(
          n,
          all.filter((e) => e.id !== id).map((e) => e.name),
        ),
      };
      await kv.put("entries", id, next);
      return next;
    },
    async remove(id, inUse = null) {
      const all = await list();
      const entry = all.find((e) => e.id === id);
      if (!entry) return;
      await kv.delete("entries", id);
      const hash = hashOf(entry.settings);
      if (hash && hash !== inUse && !all.some((e) => e.id !== id && hashOf(e.settings) === hash)) {
        await kv.delete("hdrs", hash);
      }
    },
    putHdr: (h) => kv.put("hdrs", h.hash, h),
    async getHdr(hash) {
      return (await kv.get<StoredHdr>("hdrs", hash)) ?? null;
    },
  };
}
