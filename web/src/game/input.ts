// Input mapping layer: physical keys → abstract game inputs, per context. W means "up" while walking a dungeon
// but "item slot 2" during a fight, so each context has its own table.

export type GameInput =
  | 'up' | 'down' | 'left' | 'right'
  | 'weapon1' | 'weapon2' | 'weapon3'
  | 'item1' | 'item2' | 'item3'
  | 'escape' | 'confirm' | 'bossKey' | 'close';

export type InputContext = 'dungeon' | 'combat' | 'sync' | 'menu';

const MOVE: Record<string, GameInput> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
};
const GLOBAL: Record<string, GameInput> = { Backquote: 'bossKey', Escape: 'close' };

const MAPS: Record<InputContext, Record<string, GameInput>> = {
  menu: GLOBAL,
  dungeon: { ...GLOBAL, ...MOVE },
  sync: { ...GLOBAL, ...MOVE },
  combat: {
    ...GLOBAL,
    Digit1: 'weapon1', Digit2: 'weapon2', Digit3: 'weapon3', Numpad1: 'weapon1', Numpad2: 'weapon2', Numpad3: 'weapon3',
    KeyQ: 'item1', KeyW: 'item2', KeyE: 'item3', KeyX: 'escape', Enter: 'confirm', Space: 'confirm',
  },
};

/** Null when the key means nothing here, or when the player is typing into a field. */
export function readInput(e: KeyboardEvent, ctx: InputContext): GameInput | null {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return e.code === 'Escape' ? 'close' : null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  return MAPS[ctx][e.code] ?? null;
}
