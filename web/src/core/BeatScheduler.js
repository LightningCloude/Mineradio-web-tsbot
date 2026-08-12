import { beatEngine } from './BeatEngine.js';
import { eventBus } from '../shared/EventBus.js';


export class BeatScheduler {
  constructor(engine = beatEngine, bus = eventBus) {
    this._engine = engine;
    this._bus = bus;
  }

  tick(position, active = true) {
    if (!active) return null;

    const beat = this._engine.getBeatAtWithGrid(position);
    if (!beat) return null;

    const visualBeat = Object.freeze({ ...beat, position });
    this._bus.emit('visual:beat', visualBeat);
    return visualBeat;
  }
}


export const beatScheduler = new BeatScheduler();
