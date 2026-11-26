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
  let tr = first;
  for (let i = 0; ; i++) {
    if (tr.requestState === "DONE") {
      const id = tr.resultExternalDataIds?.[0];
      if (!id) throw new OnshapeError("error.exportNoFile");
      return id;
    }
    if (tr.requestState === "FAILED") {
      throw tr.failureReason
        ? new OnshapeError("error.exportFailed", { reason: tr.failureReason })
        : new OnshapeError("error.exportFailed", {}, { lines: { reason: "error.noReason" } });
    }
    if (now() - start > timeoutMs) {
      throw new OnshapeError("error.exportTimeout", { minutes: Math.round(timeoutMs / 60000) });
    }
    await sleep(DELAYS[Math.min(i, DELAYS.length - 1)]!);
    tr = await get(first.id);
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
    const doc = await client.json<{ defaultWorkspace?: { id?: string } }>(
      "GET",
      `${link.base}/api/documents/${link.did}`,
    );
    wvmid = doc.defaultWorkspace?.id;
    wvm = "w";
    if (!wvmid) throw new OnshapeError("error.noWorkspace");
  }
  const elements = await client.json<Element[]>(
    "GET",
    `${link.base}/api/documents/d/${link.did}/${wvm}/${wvmid}/elements`,
  );
  const studio = (e: Element): Studio => ({
    base: link.base,
    did: link.did,
    wvm: wvm!,
    wvmid: wvmid!,
    eid: e.id,
    name: e.name,
  });
  if (link.eid) {
    const e = elements.find((x) => x.id === link.eid);
    if (!e) throw new OnshapeError("error.tabGone");
    if (e.elementType !== "PARTSTUDIO") {
      throw new OnshapeError(e.elementType === "ASSEMBLY" ? "error.assembly" : "error.notPartStudio", { name: e.name });
    }
    return [studio(e)];
  }
  const all = elements.filter((e) => e.elementType === "PARTSTUDIO").map(studio);
  if (!all.length) throw new OnshapeError("error.noPartStudio");
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
  const first = await client.json<Translation>(
    "POST",
    `${base}/api/partstudios/d/${did}/${wvm}/${wvmid}/e/${eid}/translations`,
    {
      formatName: "STEP",
      storeInDocument: false,
    },
  );
  const xid = await pollTranslation(
    (tid) => client.json<Translation>("GET", `${base}/api/translations/${tid}`),
    first,
    deps,
  );
  const res = await client.send("GET", `${base}/api/documents/d/${did}/externaldata/${xid}`, {
    saveAs: downloadName(s.name),
  });
  if (!res.path) throw new OnshapeError("error.exportNotSaved");
  return res.path;
}
