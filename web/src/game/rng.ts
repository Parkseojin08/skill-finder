// Seeded PRNG (sfc32). Its state is four uint32 words kept inside the game state, so the same actions always give
// the same results on the browser and on the server, and a player cannot reroll loot by reloading.

export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  between(min: number, max: number): number;
  chance(p: number): boolean;
  pick<T>(list: readonly T[]): T;
  uuid(): string;
  save(): number[];
}

export function makeRng(state: readonly number[]): Rng {
  let a = state[0] >>> 0, b = state[1] >>> 0, c = state[2] >>> 0, d = state[3] >>> 0;
  const word = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  const next = () => word() / 4294967296;
  const hex = (n: number) => n.toString(16).padStart(8, '0');
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    between: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (list) => list[Math.floor(next() * list.length)],
    uuid: () => {
      const w = [word(), word(), word(), word()].map(hex).join('');
      const variant = ((parseInt(w[16], 16) & 0x3) | 0x8).toString(16);
      return `${w.slice(0, 8)}-${w.slice(8, 12)}-4${w.slice(13, 16)}-${variant}${w.slice(17, 20)}-${w.slice(20, 32)}`;
    },
    save: () => [a >>> 0, b >>> 0, c >>> 0, d >>> 0],
  };
}

/** Four well-mixed words from one number (splitmix32), then a short warm-up. */
export function seedState(seed: number): number[] {
  let x = seed >>> 0;
  const mix = () => {
    x = (x + 0x9e3779b9) | 0;
    let z = x;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  const rng = makeRng([mix(), mix(), mix(), mix()]);
  for (let i = 0; i < 12; i++) rng.next();
  return rng.save();
}
