export type ThumbFetch = (paths: string[]) => Promise<(string | null)[]>;
export type ThumbStamp = number | null;

interface Wanted {
  stamp: ThumbStamp;
  cb: (url: string | null) => void;
}

/** Fetches card pictures in small batches, only for the cards that ask, and
 *  keeps the most recent ones. A stamp (the file's edit time) tells a picture
 *  that is still good from one taken before the file changed. */
export class ThumbQueue {
  private readonly batch: number;
  private readonly inFlight: number;
  private readonly cacheSize: number;
  private cache = new Map<string, { stamp: ThumbStamp; url: string }>();
  private wanted = new Map<string, Wanted>();
  private queued = new Set<string>();
  private sent = new Map<string, ThumbStamp>();
  private flying = 0;
  private scheduled = false;

  constructor(
    private readonly fetch: ThumbFetch,
    opts: { batch?: number; inFlight?: number; cache?: number } = {},
  ) {
    this.batch = opts.batch ?? 24;
    this.inFlight = opts.inFlight ?? 2;
    this.cacheSize = opts.cache ?? 300;
  }

  request(path: string, stamp: ThumbStamp, cb: (url: string | null) => void): void {
    const hit = this.cache.get(path);
    if (hit && hit.stamp === stamp) {
      this.cache.delete(path);
      this.cache.set(path, hit);
      cb(hit.url);
      return;
    }
    this.wanted.set(path, { stamp, cb });
    if (!this.sent.has(path)) this.queued.add(path);
    this.schedule();
  }

  cancel(path: string): void {
    this.wanted.delete(path);
    this.queued.delete(path);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.flying < this.inFlight && this.queued.size) {
      const paths = [...this.queued].slice(0, this.batch);
      for (const p of paths) {
        this.queued.delete(p);
        this.sent.set(p, this.wanted.get(p)?.stamp ?? null);
      }
      this.flying++;
      this.fetch(paths)
        .then((urls) => paths.forEach((p, i) => this.settle(p, urls[i] ?? null)))
        .catch((err) => {
          console.warn("[home] previews failed", err);
          for (const p of paths) {
            this.sent.delete(p);
            this.wanted.delete(p);
          }
        })
        .finally(() => {
          this.flying--;
          this.pump();
        });
    }
  }

  private settle(path: string, url: string | null): void {
    const stamp = this.sent.get(path) ?? null;
    this.sent.delete(path);
    this.cache.delete(path);
    // No picture is not cached: opening the document stores one without changing its stamp.
    if (url) this.cache.set(path, { stamp, url });
    while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    const want = this.wanted.get(path);
    if (!want) return;
    if (want.stamp === stamp) {
      this.wanted.delete(path);
      want.cb(url);
    } else {
      this.queued.add(path);
    }
  }
}

const shared = new WeakMap<object, ThumbQueue>();

/** One queue per library, so pictures stay cached while Home closes and opens. */
export function thumbQueueFor(lib: { thumbs: ThumbFetch }): ThumbQueue {
  let q = shared.get(lib);
  if (!q) shared.set(lib, (q = new ThumbQueue((paths) => lib.thumbs(paths))));
  return q;
}
