// Where the game state lives. The screen only talks to a GameBackend: LocalBackend runs the engine in this browser
// and saves to localStorage; the online version will send the same actions to the game API instead.

import { applyActions, createGame, type Action, type Clock } from './actions.ts';
import { GameError, type GameState } from './core.ts';

export interface Snapshot { state: GameState; version: number }

export interface GameBackend {
  load(): Promise<Snapshot>;
  /** Applies a batch. Throws GameError with a message for the player when the batch is refused. */
  send(version: number, actions: Action[]): Promise<Snapshot>;
  reset(): Promise<Snapshot>;
}

export const browserClock = (): Clock => ({ now: Date.now(), utcOffsetMin: -new Date().getTimezoneOffset() });

const KEY = 'arasaka-in-save-v2';

function randomSeed(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0];
}

export class LocalBackend implements GameBackend {
  private read(): Snapshot | null {
    try {
      const raw = localStorage.getItem(KEY);
      const snap = raw ? (JSON.parse(raw) as Snapshot) : null;
      return snap?.state?.v === 2 ? snap : null;
    } catch {
      return null;
    }
  }

  private write(snap: Snapshot) {
    try {
      localStorage.setItem(KEY, JSON.stringify(snap));
    } catch {
      // storage full or blocked: the game keeps running for this session
    }
  }

  async load(): Promise<Snapshot> {
    const found = this.read();
    if (found) return found;
    return this.reset();
  }

  async send(version: number, actions: Action[]): Promise<Snapshot> {
    const current = this.read() ?? (await this.reset());
    if (current.version !== version) throw new GameError('다른 창에서 진행이 바뀌었습니다. 최신 상태를 불러왔습니다');
    const next = { state: applyActions(current.state, actions, browserClock()), version: version + 1 };
    this.write(next);
    return next;
  }

  async reset(): Promise<Snapshot> {
    const snap = { state: createGame(randomSeed(), browserClock()), version: 0 };
    this.write(snap);
    return snap;
  }
}
