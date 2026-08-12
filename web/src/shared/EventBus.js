/**
 * Lightweight pub/sub event bus for decoupled module communication.
 * All visual and player modules communicate exclusively through this bus
 * and StateManager — never through direct imports of each other.
 */
class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, []);
    }
    this._listeners.get(event).push(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const list = this._listeners.get(event);
    if (list) {
      const idx = list.indexOf(callback);
      if (idx !== -1) list.splice(idx, 1);
    }
  }

  emit(event, data) {
    const list = this._listeners.get(event);
    if (list) {
      for (const cb of list) {
        try { cb(data); } catch (e) { console.error(`[EventBus] ${event} handler error:`, e); }
      }
    }
  }

  once(event, callback) {
    const wrapper = (data) => {
      this.off(event, wrapper);
      callback(data);
    };
    this.on(event, wrapper);
  }
}

export const eventBus = new EventBus();
