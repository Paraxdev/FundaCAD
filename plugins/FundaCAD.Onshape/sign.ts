// Onshape's API key signature, as its reference client builds it:
// HMAC-SHA256 over method, nonce, date, content type, path and query, one per
// line with a trailing newline, all lowercased. The secret is not lowercased.

export interface SignInput {
  method: string;
  url: string;
  contentType: string;
  access: string;
  secret: string;
  date?: string;
  nonce?: string;
}

export interface SignedHeaders {
  Date: string;
  "On-Nonce": string;
  "Content-Type": string;
  Authorization: string;
}

const NONCE_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(25));
  return Array.from(bytes, (b) => NONCE_CHARS[b % NONCE_CHARS.length]).join("");
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function signOnshape(input: SignInput): Promise<SignedHeaders> {
  const date = input.date ?? new Date().toUTCString();
  const nonce = input.nonce ?? makeNonce();
  const url = new URL(input.url);
  const query = url.search.replace(/^\?/, "");
  const text = [input.method, nonce, date, input.contentType, url.pathname, query, ""].join("\n").toLowerCase();
  if (!globalThis.crypto?.subtle) throw new Error("this window has no WebCrypto, so Onshape requests cannot be signed");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(text)));
  return {
    Date: date,
    "On-Nonce": nonce,
    "Content-Type": input.contentType,
    Authorization: `On ${input.access}:HmacSHA256:${toBase64(sig)}`,
  };
}
