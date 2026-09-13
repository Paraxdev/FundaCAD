/** A Map that forgets its least recently used entries past `max`. For caches
 *  keyed by something a drag changes every frame, which a plain Map keeps
 *  forever. */
export class LruCache<K, V> {
  private map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): this {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value as K;
      this.map.delete(oldest);
    }
    return this;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear() {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
