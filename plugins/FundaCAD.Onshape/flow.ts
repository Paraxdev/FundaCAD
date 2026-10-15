import { importPath, reportError, toast } from "fundacad";
import type { DocumentStore, GeometryBackend } from "fundacad";
import { onshapeClient, type Keys } from "./client";
import { askForLink } from "./dialog";
import { loadKeys, removeDownload, saveKeys, webRequest } from "./native";
import { downloadStep, studiosOf } from "./translate";
import { parseOnshapeUrl, sourceOf } from "./url";

function abortableSleep(signal: AbortSignal) {
  return (ms: number) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, ms);
      const stop = () => {
        clearTimeout(t);
        reject(signal.reason);
      };
      signal.addEventListener("abort", stop, { once: true });
    });
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop()!;
}

/** File, Import from Onshape link: ask, export every part studio as STEP, import each. */
export async function importFromOnshape(store: DocumentStore, geometry: GeometryBackend): Promise<void> {
  let stored: Keys | null = null;
  try {
    stored = await loadKeys();
  } catch {
    // No credential store (a Linux desktop without a secret service): ask each time.
  }
  const answer = await askForLink(!stored);
  if (!answer) return;
  const keys = answer.keys ?? stored;
  const link = parseOnshapeUrl(answer.link);
  if (!keys || "error" in link) return;
  if (answer.keys && answer.remember) {
    try {
      await saveKeys(answer.keys);
    } catch (e) {
      toast(`The keys could not be saved, so they are used for this import only. ${String(e)}`, { kind: "warning" });
    }
  }

  // Cancel aborts between requests: one already sent finishes, and a file it
  // saved is removed below.
  const abort = new AbortController();
  const { signal } = abort;
  const sleep = abortableSleep(signal);
  const transport = (req: Parameters<typeof webRequest>[0]) => {
    signal.throwIfAborted();
    return webRequest(req);
  };
  const client = onshapeClient({ transport, keys, sleep });
  try {
    const studios = await store.runBusy("Reading the Onshape document", () => studiosOf(client, link), { abort });
    for (const studio of studios) {
      const path = await store.runBusy(
        `Exporting ${studio.name} from Onshape`,
        () => downloadStep(client, studio, { sleep, now: Date.now }),
        { abort },
      );
      try {
        signal.throwIfAborted();
        await importPath(store, geometry, path, undefined, {
          source: sourceOf({ ...link, wvm: studio.wvm, wvmid: studio.wvmid, eid: studio.eid }),
        });
      } finally {
        await removeDownload(fileNameOf(path)).catch(() => undefined);
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    await reportError(`Couldn't import from Onshape: ${e instanceof Error ? e.message : String(e)}`);
  }
}
