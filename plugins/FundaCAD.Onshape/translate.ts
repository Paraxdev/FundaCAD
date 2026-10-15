import { OnshapeError, type OnshapeClient } from "./client";
import type { OnshapeLink, Wvm } from "./url";

export interface Translation {
  id: string;
  requestState: "ACTIVE" | "DONE" | "FAILED" | string;
  failureReason?: string;
  resultExternalDataIds?: string[];
}

export interface PollDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  timeoutMs?: number;
}

// Onshape asks for about one request a second at most.
const DELAYS = [1000, 2000, 3000, 5000];

/** Wait for a translation, resolving to the id of the file it made. */
export async function pollTranslation(
  get: (tid: string) => Promise<Translation>,
  first: Translation,
  { sleep, now, timeoutMs = 600_000 }: PollDeps,
): Promise<string> {
  const start = now();
  let t = first;
  for (let i = 0; ; i++) {
    if (t.requestState === "DONE") {
      const id = t.resultExternalDataIds?.[0];
      if (!id) throw new OnshapeError("Onshape finished the STEP export but sent no file");
      return id;
    }
    if (t.requestState === "FAILED") {
      throw new OnshapeError(`Onshape could not export STEP: ${t.failureReason || "no reason given"}`);
    }
    if (now() - start > timeoutMs) {
      throw new OnshapeError(`Onshape has not finished the STEP export after ${Math.round(timeoutMs / 60000)} minutes`);
    }
    await sleep(DELAYS[Math.min(i, DELAYS.length - 1)]!);
    t = await get(first.id);
  }
}

export interface Element {
  id: string;
  name: string;
  elementType: string;
}

export interface Studio {
  base: string;
  did: string;
  wvm: Wvm;
  wvmid: string;
  eid: string;
  name: string;
}

/** The part studios a link names: its own element, or every one in the document. */
export async function studiosOf(client: OnshapeClient, link: OnshapeLink): Promise<Studio[]> {
  let wvm = link.wvm;
  let wvmid = link.wvmid;
  if (!wvm || !wvmid) {
    const doc = await client.json<{ defaultWorkspace?: { id?: string } }>("GET", `${link.base}/api/documents/${link.did}`);
    wvmid = doc.defaultWorkspace?.id;
    wvm = "w";
    if (!wvmid) throw new OnshapeError("Onshape did not say which workspace the document opens in");
  }
  const elements = await client.json<Element[]>(
    "GET",
    `${link.base}/api/documents/d/${link.did}/${wvm}/${wvmid}/elements`,
  );
  const studio = (e: Element): Studio => ({ base: link.base, did: link.did, wvm: wvm!, wvmid: wvmid!, eid: e.id, name: e.name });
  if (link.eid) {
    const e = elements.find((x) => x.id === link.eid);
    if (!e) throw new OnshapeError("That tab is not in the document any more");
    if (e.elementType !== "PARTSTUDIO") {
      const what = e.elementType === "ASSEMBLY" ? "an assembly" : "not a part studio";
      throw new OnshapeError(`"${e.name}" is ${what}. Link a part studio instead`);
    }
    return [studio(e)];
  }
  const all = elements.filter((e) => e.elementType === "PARTSTUDIO").map(studio);
  if (!all.length) throw new OnshapeError("That document has no part studio");
  return all;
}

/** A name `plugin_web_request` accepts for a download. */
export function downloadName(name: string): string {
  const base = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 90);
  return `${base || "part-studio"}.step`;
}

/** Export one part studio as STEP and download it. Resolves to the local path. */
export async function downloadStep(client: OnshapeClient, s: Studio, deps: PollDeps): Promise<string> {
  const { base, did, wvm, wvmid, eid } = s;
  const first = await client.json<Translation>("POST", `${base}/api/partstudios/d/${did}/${wvm}/${wvmid}/e/${eid}/translations`, {
    formatName: "STEP",
    storeInDocument: false,
  });
  const xid = await pollTranslation((tid) => client.json<Translation>("GET", `${base}/api/translations/${tid}`), first, deps);
  const res = await client.send("GET", `${base}/api/documents/d/${did}/externaldata/${xid}`, { saveAs: downloadName(s.name) });
  if (!res.path) throw new OnshapeError("Onshape sent the STEP file but it was not saved");
  return res.path;
}
