/** Cancel obsolete work and reject late responses, even if a transport ignores abort. */
export class LatestRequest {
  constructor() {
    this._generation = 0;
    this._controller = null;
  }

  cancel() {
    this._generation += 1;
    this._controller?.abort();
    this._controller = null;
  }

  begin() {
    this.cancel();
    this._controller = new AbortController();
    const generation = this._generation;
    const signal = this._controller.signal;
    return { signal, isCurrent: () => generation === this._generation && !signal.aborted };
  }
}
