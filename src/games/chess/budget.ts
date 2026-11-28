/** a level's own think time when the clock allows it (ms) */
const LEVEL_MS = [60, 100, 150, 250, 400, 600, 1000, 1600];

/** a bot's budget: its level's time, but never more than 1/30 of its clock plus most of the increment; tiny when the flag is close */
export function botBudgetMs(level: number, leftMs: number | null, incMs: number): number {
  const own = LEVEL_MS[Math.min(Math.max(level, 1), 8) - 1];
  if (leftMs === null) return own;
  const share = leftMs / 30 + incMs * 0.8;
  const cap = leftMs < 3_000 ? 40 : leftMs < 10_000 ? 150 : Infinity;
  return Math.max(20, Math.floor(Math.min(own, share, cap)));
}

/** a small seeded generator (mulberry32), so a think repeats with its seed */
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
