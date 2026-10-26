/** Page-local exclusion: let in-flight writes settle before a destructive clear. */
export class QueueMutationGate {
  constructor() { this.clearing = false; this._pending = new Set(); this._listeners = new Set(); this._uncertain = false; }
  subscribe(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _notify() { for (const fn of this._listeners) fn(this.clearing); }
  async write(operation) {
    if (this.clearing) {
      const error = new Error('正在清空队列，请稍后再加入歌曲'); error.status = 409; throw error;
    }
    // Register before invoking the operation, including synchronous throws.
    const pending = Promise.resolve().then(operation);
    this._pending.add(pending);
    try { return await pending; }
    catch (error) { if (this.clearing && !error.status) this._uncertain = true; throw error; }
    finally { this._pending.delete(pending); }
  }
  beginClear() {
    if (this.clearing) return false;
    this._uncertain = false; this.clearing = true; this._notify(); return true;
  }
  async drain() { await Promise.allSettled([...this._pending]); return !this._uncertain; }
  endClear() { this.clearing = false; this._notify(); }
}

export const queueMutationGate = new QueueMutationGate();
