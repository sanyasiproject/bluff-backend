import { BOMB_ARROWS, BOMB_INKS, BOMB_TASK_KINDS, type BombTask, type BombTaskKind } from '../../types.js';

/** a task with its answer (the answer never leaves the server) */
export interface BombTaskFull {
  task: BombTask;
  answer: number;
}

/** a small seeded random (mulberry32), so a game's tasks come from its seed */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
function shuffle<T>(r: () => number, a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 4 number choices: the answer and 3 near misses, shuffled; returns the choices and the answer's index */
function numberChoices(r: () => number, ans: number, spread: number, min = 0): { choices: string[]; answer: number } {
  const set = new Set<number>([ans]);
  const near = [1, -1, 2, -2, spread, -spread, 10, -10, 3, -3];
  shuffle(r, near);
  for (const d of near) {
    if (set.size >= 4) break;
    if (ans + d >= min) set.add(ans + d);
  }
  for (let k = 1; set.size < 4; k++) set.add(ans + k + 3);
  const list = shuffle(r, [...set]);
  return { choices: list.map(String), answer: list.indexOf(ans) };
}

const EMOJI = [
  ['🍎', '🍌', '🍇', '🍉', '🍓', '🍒', '🍍', '🥭'],
  ['🐶', '🐱', '🐭', '🐰', '🦊', '🐻', '🐼', '🐯'],
  ['🚗', '🚕', '🚌', '🚓', '🚑', '🚒', '🚜', '🚲'],
  ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🏉', '🎱'],
];

/** a kind other than the last one */
export function nextKind(r: () => number, prev: BombTaskKind | null): BombTaskKind {
  const kinds = BOMB_TASK_KINDS.filter((k) => k !== prev);
  return kinds[Math.floor(r() * kinds.length)];
}

/** a task of this kind; d 0..3 makes it a little harder as rounds go on */
export function makeTask(r: () => number, id: number, kind: BombTaskKind, d: number): BombTaskFull {
  if (kind === 'sum') {
    const top = [9, 15, 25, 50][d];
    let a = int(r, 2, top);
    let b = int(r, 2, top);
    const minus = d > 0 && r() < 0.5;
    if (minus && b > a) [a, b] = [b, a];
    const ans = minus ? a - b : a + b;
    const c = numberChoices(r, ans, 5);
    return { task: { id, kind, prompt: `${a} ${minus ? '−' : '+'} ${b}`, choices: c.choices }, answer: c.answer };
  }
  if (kind === 'bigger') {
    const top = [50, 99, 99, 999][d];
    const gap = [12, 6, 2, 1][d];
    let a = int(r, 1, top - gap);
    let b = a + int(r, gap, Math.max(gap, Math.min(top - a, gap * 3)));
    if (r() < 0.5) [a, b] = [b, a];
    return { task: { id, kind, prompt: 'Tap the bigger number', choices: [String(a), String(b)] }, answer: a > b ? 0 : 1 };
  }
  if (kind === 'colour') {
    const inks = shuffle(r, [...BOMB_INKS]);
    const ink = inks[0];
    const word = inks[1].toUpperCase();
    const choices = shuffle(r, [...BOMB_INKS]);
    return { task: { id, kind, prompt: 'Tap the colour of the ink', word, ink, choices: [...choices] }, answer: choices.indexOf(ink) };
  }
  if (kind === 'odd') {
    const groups = shuffle(r, [0, 1, 2, 3]);
    const same = shuffle(r, [...EMOJI[groups[0]]]).slice(0, 3);
    const odd = EMOJI[groups[1]][int(r, 0, 7)];
    const choices = shuffle(r, [...same, odd]);
    return { task: { id, kind, prompt: 'Tap the odd one out', choices }, answer: choices.indexOf(odd) };
  }
  if (kind === 'count') {
    const n = int(r, 3, [6, 7, 8, 9][d]);
    const dots: [number, number][] = [];
    for (let tries = 0; dots.length < n && tries < 500; tries++) {
      const p: [number, number] = [Math.round((0.12 + r() * 0.76) * 100) / 100, Math.round((0.12 + r() * 0.76) * 100) / 100];
      if (dots.every(([x, y]) => (x - p[0]) ** 2 + (y - p[1]) ** 2 > 0.17 * 0.17)) dots.push(p);
    }
    const c = numberChoices(r, dots.length, 1, 1);
    return { task: { id, kind, prompt: 'How many dots?', dots, choices: c.choices }, answer: c.answer };
  }
  const arrow = BOMB_ARROWS[int(r, 0, 3)];
  return { task: { id, kind: 'arrow', prompt: 'Swipe the way it points', arrow, choices: [...BOMB_ARROWS] }, answer: BOMB_ARROWS.indexOf(arrow) };
}
