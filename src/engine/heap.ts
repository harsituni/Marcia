/**
 * Binary min-heap of integer ids keyed by number, backed by typed arrays.
 *
 * There is no decrease-key: A* pushes an id again when it finds a cheaper
 * path and skips stale entries when they're popped (lazy deletion).
 */
export class MinHeap {
  private ids: Int32Array;
  private keys: Float64Array;
  private n = 0;

  constructor(capacity = 1024) {
    const cap = Math.max(1, capacity);
    this.ids = new Int32Array(cap);
    this.keys = new Float64Array(cap);
  }

  get size(): number {
    return this.n;
  }

  clear(): void {
    this.n = 0;
  }

  push(id: number, key: number): void {
    if (this.n === this.ids.length) this.grow();
    const ids = this.ids;
    const keys = this.keys;
    let i = this.n++;
    // Sift up.
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const pk = keys[parent]!;
      if (pk <= key) break;
      ids[i] = ids[parent]!;
      keys[i] = pk;
      i = parent;
    }
    ids[i] = id;
    keys[i] = key;
  }

  /** Key of the smallest entry. Only valid when `size > 0`. */
  peekKey(): number {
    return this.keys[0]!;
  }

  /** Removes and returns the id with the smallest key, or -1 if empty. */
  pop(): number {
    if (this.n === 0) return -1;
    const ids = this.ids;
    const keys = this.keys;
    const top = ids[0]!;
    const last = --this.n;
    if (last > 0) {
      const id = ids[last]!;
      const key = keys[last]!;
      // Sift down.
      let i = 0;
      const half = last >> 1;
      while (i < half) {
        let child = 2 * i + 1;
        const right = child + 1;
        if (right < last && keys[right]! < keys[child]!) child = right;
        if (keys[child]! >= key) break;
        ids[i] = ids[child]!;
        keys[i] = keys[child]!;
        i = child;
      }
      ids[i] = id;
      keys[i] = key;
    }
    return top;
  }

  private grow(): void {
    const ids = new Int32Array(this.ids.length * 2);
    const keys = new Float64Array(this.keys.length * 2);
    ids.set(this.ids);
    keys.set(this.keys);
    this.ids = ids;
    this.keys = keys;
  }
}
