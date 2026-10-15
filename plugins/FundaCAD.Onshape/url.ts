export type Wvm = "w" | "v" | "m";

export interface OnshapeLink {
  /** scheme and host, `https://cad.onshape.com` or a company's own host */
  base: string;
  did: string;
  wvm?: Wvm;
  wvmid?: string;
  eid?: string;
}

const ID = "[0-9a-f]{24}";
const PATH = new RegExp(`^/documents/(${ID})(?:/([wvm])/(${ID})(?:/e/(${ID}))?)?/?$`);

/** One label under onshape.com, the rule the manifest's `.onshape.com` grants in the app. */
export function isOnshapeHost(host: string): boolean {
  return /^[^.]+\.onshape\.com$/i.test(host);
}

export function parseOnshapeUrl(text: string): OnshapeLink | { error: string } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { error: "That is not a link. Copy the address of an Onshape document or part studio." };
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !isOnshapeHost(url.hostname)) {
    return { error: "That is not an Onshape link. It should start with https://cad.onshape.com/documents/" };
  }
  const m = PATH.exec(url.pathname.toLowerCase());
  if (!m) {
    return { error: "That link does not point at an Onshape document. Open the part studio and copy its address." };
  }
  const [, did, wvm, wvmid, eid] = m;
  return {
    base: `https://${url.hostname}`,
    did: did!,
    ...(wvm ? { wvm: wvm as Wvm, wvmid } : {}),
    ...(eid ? { eid } : {}),
  };
}

/** What the import feature records as its source: the link with no query. */
export function sourceOf(link: OnshapeLink): string {
  let s = `${link.base}/documents/${link.did}`;
  if (link.wvm && link.wvmid) s += `/${link.wvm}/${link.wvmid}`;
  if (link.eid) s += `/e/${link.eid}`;
  return s;
}
