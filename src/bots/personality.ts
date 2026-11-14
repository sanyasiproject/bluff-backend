import type { BotStyle, Personality, Rand } from './models.js';

/** bot names; a room never has two of the same */
export const BOT_NAMES = ['Raju', 'Pinky', 'Bunty', 'Chintu', 'Golu', 'Munni', 'Tinku', 'Pappu', 'Dolly', 'Bablu', 'Guddu', 'Isha', 'Vihu', 'Ningu'] as const;

type Range = [number, number];
type Recipe = Record<Exclude<keyof Personality, 'style'>, Range>;

/** each style is a range per trait; every bot draws its own numbers inside it */
const STYLES: Record<BotStyle, Recipe> = {
  // cold and careful: counts cards, lies small, calls on the numbers
  shark: {
    bluff: [0.3, 0.45], padMax: [1, 2], openBluff: [0.2, 0.35], call: [-0.1, 0.15], pileFear: [0.3, 0.5], readWeight: [0.7, 0.9],
    memory: [0.85, 1], sandbag: [0.1, 0.25], closer: [0.6, 0.8], tilt: [-0.2, 0.1], temper: [0.35, 0.55], tempo: [0.9, 1.2], peek: [0.5, 0.8], chatty: [0.05, 0.15],
  },
  // lies all the time and calls everything
  maniac: {
    bluff: [0.7, 0.9], padMax: [2, 3], openBluff: [0.55, 0.8], call: [0.35, 0.6], pileFear: [0.05, 0.2], readWeight: [0.2, 0.4],
    memory: [0.4, 0.6], sandbag: [0, 0.1], closer: [0.7, 1], tilt: [0.4, 0.8], temper: [0.7, 1], tempo: [0.55, 0.85], peek: [0.2, 0.4], chatty: [0.25, 0.4],
  },
  // honest and slow; calls only when sure
  rock: {
    bluff: [0.08, 0.2], padMax: [1, 1], openBluff: [0.03, 0.12], call: [-0.6, -0.3], pileFear: [0.6, 0.9], readWeight: [0.4, 0.6],
    memory: [0.75, 0.95], sandbag: [0.2, 0.4], closer: [0.3, 0.5], tilt: [-0.7, -0.4], temper: [0.25, 0.4], tempo: [1.2, 1.6], peek: [0.6, 0.9], chatty: [0.03, 0.1],
  },
  // watches people; goes after whoever has lied before
  detective: {
    bluff: [0.25, 0.4], padMax: [1, 2], openBluff: [0.15, 0.3], call: [0.1, 0.3], pileFear: [0.3, 0.5], readWeight: [0.85, 1],
    memory: [0.8, 1], sandbag: [0.1, 0.2], closer: [0.5, 0.7], tilt: [-0.3, 0], temper: [0.4, 0.6], tempo: [1, 1.3], peek: [0.7, 1], chatty: [0.1, 0.2],
  },
  // small sneaky lies mixed into real cards; likes opening with fakes
  trickster: {
    bluff: [0.5, 0.65], padMax: [1, 1], openBluff: [0.45, 0.7], call: [-0.15, 0.1], pileFear: [0.35, 0.55], readWeight: [0.5, 0.7],
    memory: [0.65, 0.85], sandbag: [0.25, 0.45], closer: [0.5, 0.7], tilt: [0, 0.3], temper: [0.6, 0.85], tempo: [0.8, 1.1], peek: [0.3, 0.6], chatty: [0.15, 0.3],
  },
  // plays for the big moments: huge piles and the finish
  gambler: {
    bluff: [0.45, 0.6], padMax: [2, 3], openBluff: [0.3, 0.5], call: [0, 0.25], pileFear: [0, 0.15], readWeight: [0.4, 0.6],
    memory: [0.6, 0.8], sandbag: [0.05, 0.15], closer: [0.85, 1], tilt: [0.2, 0.5], temper: [0.55, 0.8], tempo: [0.7, 1.1], peek: [0.4, 0.7], chatty: [0.15, 0.3],
  },
};

export const BOT_STYLES = Object.keys(STYLES) as BotStyle[];

const draw = (rand: Rand, [lo, hi]: Range) => lo + rand() * (hi - lo);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function makePersonality(style: BotStyle, rand: Rand): Personality {
  const r = STYLES[style];
  const traits = Object.fromEntries(Object.entries(r).map(([k, range]) => [k, draw(rand, range)])) as Omit<Personality, 'style'>;
  return { ...traits, style, padMax: Math.round(traits.padMax) };
}

/** a little mood for each new game, so the same bot never plays two games quite the same */
export function drift(p: Personality, rand: Rand): Personality {
  const wobble = (v: number, lo = 0, hi = 1) => clamp(v + (rand() - 0.5) * 0.14, lo, hi);
  return {
    ...p,
    bluff: wobble(p.bluff),
    openBluff: wobble(p.openBluff),
    call: wobble(p.call, -1, 1),
    pileFear: wobble(p.pileFear),
    sandbag: wobble(p.sandbag),
    closer: wobble(p.closer),
    temper: wobble(p.temper, 0.15, 1.2),
    tempo: wobble(p.tempo, 0.5, 1.8),
  };
}

/** a style nobody at the table plays yet, else any */
export function pickStyle(taken: BotStyle[], rand: Rand): BotStyle {
  const free = BOT_STYLES.filter((s) => !taken.includes(s));
  const from = free.length > 0 ? free : BOT_STYLES;
  return from[Math.floor(rand() * from.length)];
}

/** a bot name nobody in the room uses (case-insensitive) */
export function pickName(taken: string[], rand: Rand): string | null {
  const used = new Set(taken.map((n) => n.toLowerCase()));
  const free = BOT_NAMES.filter((n) => !used.has(n.toLowerCase()));
  return free.length > 0 ? free[Math.floor(rand() * free.length)] : null;
}
