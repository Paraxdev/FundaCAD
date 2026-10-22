// Set before the tracer starts and cleared at its first sample. Note: Chromium writes localStorage to disk
// seconds late, so the IndexedDB copy is committed with durability "strict", which waits for the disk.

const KEY = "fundacad.ptStarting";
const DB = "fundacad-pathtrace";
const STORE = "guard";

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function writeDb(value: boolean): Promise<void> {
  const db = await openDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
      if (value) tx.objectStore(STORE).put(Date.now(), KEY);
      else tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  db.close();
}

async function readDb(): Promise<boolean> {
  const db = await openDb();
  if (!db) return false;
  const v = await new Promise<unknown>((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
  db.close();
  return v !== undefined;
}

export function guardSetSync(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

export async function guardSet(): Promise<boolean> {
  return guardSetSync() || (await readDb());
}

export async function armGuard(): Promise<void> {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {
    /* no storage, the IndexedDB copy still counts */
  }
  await writeDb(true);
}

export function clearGuard(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
  void writeDb(false);
}
