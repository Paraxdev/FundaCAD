import { signOnshape } from "./sign";
import { isOnshapeHost } from "./url";

export interface WebRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: { kind: "json"; value: unknown };
  /** stream the reply into this plugin's downloads under this name */
  saveAs?: string;
  timeoutMs?: number;
}

export interface WebResponse {
  status: number;
  contentType: string | null;
  location: string | null;
  retryAfter: string | null;
  text: string | null;
  path: string | null;
  len: number | null;
}

export type Transport = (req: WebRequest) => Promise<WebResponse>;

export interface Keys {
  access: string;
  secret: string;
}

export class OnshapeError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export interface ClientDeps {
  transport: Transport;
  keys: Keys;
  sleep: (ms: number) => Promise<void>;
}

const MAX_HOPS = 3;
const MAX_RETRIES = 5;

function reasonOf(res: WebResponse): string {
  try {
    const j = JSON.parse(res.text ?? "") as { message?: unknown };
    if (typeof j.message === "string" && j.message) return `: ${j.message.slice(0, 200)}`;
  } catch {
    // not JSON, the status says enough
  }
  return "";
}

export function onshapeClient({ transport, keys, sleep }: ClientDeps) {
  async function send(
    method: string,
    url: string,
    opts: { body?: unknown; saveAs?: string } = {},
  ): Promise<WebResponse> {
    let hops = 0;
    let retries = 0;
    for (;;) {
      const host = new URL(url).hostname;
      if (!isOnshapeHost(host)) throw new OnshapeError(`Onshape sent the request on to ${host}, which is not Onshape`);
      // The reference client signs every request as JSON, GETs included.
      const signed = await signOnshape({ method, url, contentType: "application/json", ...keys });
      const headers: [string, string][] = [
        ...Object.entries(signed),
        ["Accept", opts.saveAs ? "application/octet-stream" : "application/json;charset=UTF-8; qs=0.09"],
      ];
      const res = await transport({
        method,
        url,
        headers,
        ...(opts.body !== undefined ? { body: { kind: "json" as const, value: opts.body } } : {}),
        ...(opts.saveAs ? { saveAs: opts.saveAs, timeoutMs: 600_000 } : { timeoutMs: 60_000 }),
      });
      if (res.status === 307 || res.status === 308) {
        if (!res.location || ++hops > MAX_HOPS) throw new OnshapeError("Onshape redirected the request too many times");
        url = new URL(res.location, url).toString();
        continue;
      }
      if (res.status === 429) {
        if (++retries > MAX_RETRIES)
          throw new OnshapeError("Onshape is asking for fewer requests, try again in a minute", 429);
        const secs = Number(res.retryAfter);
        await sleep(Math.min(Number.isFinite(secs) && secs > 0 ? secs : 2, 60) * 1000);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new OnshapeError(
          "Onshape refused the keys. Check the access and secret key, and that the key may read documents",
          res.status,
        );
      }
      if (res.status === 404) {
        throw new OnshapeError("Onshape could not find that document, or these keys cannot open it", 404);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new OnshapeError(`Onshape answered ${res.status}${reasonOf(res)}`, res.status);
      }
      return res;
    }
  }

  async function json<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await send(method, url, body === undefined ? {} : { body });
    try {
      return JSON.parse(res.text ?? "") as T;
    } catch {
      throw new OnshapeError("Onshape sent a reply that is not JSON");
    }
  }

  return { send, json };
}

export type OnshapeClient = ReturnType<typeof onshapeClient>;
