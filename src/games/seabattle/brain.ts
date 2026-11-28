import { SEA_SIZE, type BotLevel, type SeaMoveInput, type SeaView } from '../../types.js';

const N = SEA_SIZE;

/** what a bot knows of one sea: 0 unknown, 1 water (missed, or known empty), 2 hit on a ship still afloat, 3 sunk */
function knowledge(v: SeaView, target: string, level: BotLevel): number[] {
  const sea = v.seas[target];
  const k = sea.shots.map((s) => (s === 3 ? 3 : s));
  if (level === 'normal') return k;
  // ships never touch: round a sunk ship is water
  for (const s of sea.ships) {
    if (!s.sunk) continue;
    for (let i = 0; i < s.len; i++) {
      const x = s.v ? s.x : s.x + i;
      const y = s.v ? s.y + i : s.y;
      for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
        const cx = x + ox;
        const cy = y + oy;
        if (cx >= 0 && cy >= 0 && cx < N && cy < N && k[cy * N + cx] === 0) k[cy * N + cx] = 1;
      }
    }
  }
  // my radar scans that found nothing
  for (const r of v.radars) {
    if (r.target !== target || r.count > 0) continue;
    for (let y = r.y; y < r.y + 3; y++) for (let x = r.x; x < r.x + 3; x++) if (k[y * N + x] === 0) k[y * N + x] = 1;
  }
  return k;
}

/** how many ways the ships still afloat could cover each unknown cell (must cover a hit while hunting one down) */
function density(k: number[], afloat: number[], needHit: boolean): number[] {
  const d = new Array(N * N).fill(0);
  for (const len of afloat) {
    for (const v of [false, true]) {
      for (let y = 0; y < (v ? N - len + 1 : N); y++) {
        for (let x = 0; x < (v ? N : N - len + 1); x++) {
          const cells: number[] = [];
          let ok = true;
          let hits = 0;
          for (let i = 0; i < len && ok; i++) {
            const c = v ? (y + i) * N + x : y * N + x + i;
            if (k[c] === 1 || k[c] === 3) ok = false;
            if (k[c] === 2) hits++;
            cells.push(c);
          }
          if (!ok || (needHit && hits === 0)) continue;
          const w = needHit ? 1 + hits * 4 : 1;
          for (const c of cells) if (k[c] === 0) d[c] += w;
        }
      }
    }
  }
  return d;
}

const openHits = (k: number[]) => k.flatMap((s, i) => (s === 2 ? [i] : []));

/** target mode, plain: along a line of hits, else round a hit */
function chase(k: number[], rand: () => number): number | null {
  const hits = openHits(k);
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x < N && y < N && k[y * N + x] === 0;
  for (const h of hits) {
    const x = h % N;
    const y = Math.floor(h / N);
    for (const [dx, dy] of [[1, 0], [0, 1]] as const) {
      if (!hits.includes((y + dy) * N + x + dx) || x + dx >= N) continue;
      // a line: walk both ways to its open ends
      let a = 0;
      while (k[(y - dy * (a + 1)) * N + x - dx * (a + 1)] === 2 && x - dx * (a + 1) >= 0 && y - dy * (a + 1) >= 0) a++;
      let b = 1;
      while (x + dx * (b + 1) < N && y + dy * (b + 1) < N && k[(y + dy * (b + 1)) * N + x + dx * (b + 1)] === 2) b++;
      const ends = [[x - dx * (a + 1), y - dy * (a + 1)], [x + dx * (b + 1), y + dy * (b + 1)]].filter(([cx, cy]) => free(cx, cy));
      if (ends.length > 0) {
        const [cx, cy] = ends[Math.floor(rand() * ends.length)];
        return cy * N + cx;
      }
    }
  }
  const round: number[] = [];
  for (const h of hits) {
    const x = h % N;
    const y = Math.floor(h / N);
    for (const [cx, cy] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) if (free(cx, cy)) round.push(cy * N + cx);
  }
  return round.length > 0 ? round[Math.floor(rand() * round.length)] : null;
}

/** the densest unknown cell (any unknown one when nothing fits) */
const best = (d: number[], k: number[], rand: () => number) => {
  const open = k.flatMap((s, i) => (s === 0 ? [i] : []));
  const top = Math.max(...open.map((i) => d[i]));
  const all = open.filter((i) => d[i] === top);
  return all[Math.floor(rand() * all.length)];
};

/** the next shot or power, from the bot's own view only */
export function decide(v: SeaView, me: string, level: BotLevel, rand: () => number): SeaMoveInput {
  const foes = Object.keys(v.seas).filter((id) => id !== me && v.seas[id].afloat.length > 0 && !(id in v.places));
  const left = (id: string) => v.seas[id].afloat.reduce((s, l) => s + l, 0) - v.seas[id].shots.filter((s) => s === 2).length;
  const hunting = foes.filter((id) => v.seas[id].shots.some((s) => s === 2));
  let target: string;
  if (level !== 'normal' && hunting.length > 0) target = hunting[0];
  else if (level === 'normal' && hunting.length > 0 && rand() < 0.6) target = hunting[Math.floor(rand() * hunting.length)];
  else if (level === 'normal') target = foes[Math.floor(rand() * foes.length)];
  else target = foes.reduce((a, b) => (left(b) < left(a) ? b : a));
  const k = knowledge(v, target, level);
  const afloat = v.seas[target].afloat;
  const held = v.held[me] ?? [];
  const chasing = openHits(k).length > 0;
  const at = (c: number) => ({ x: c % N, y: Math.floor(c / N) });
  if (chasing) {
    if (level === 'expert') return { type: 'fire', target, ...at(best(density(k, afloat, true), k, rand)) };
    const c = chase(k, rand);
    if (c !== null) return { type: 'fire', target, ...at(c) };
  }
  const d = density(k, afloat, false);
  // powers while hunting: Normal now and then, the others always
  const usePower = held.length > 0 && (level !== 'normal' || rand() < 0.4);
  if (usePower && held.includes('radar')) {
    let bestC = 0;
    let bestSum = -1;
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      let s = 0;
      for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) s += d[(y + oy) * N + x + ox];
      if (s > bestSum) [bestSum, bestC] = [s, y * N + x];
    }
    return { type: 'radar', target, ...at(bestC) };
  }
  if (usePower && held.includes('salvo')) {
    const order = d.map((w, i) => [w + rand() * 0.01, i] as const).filter(([, i]) => k[i] === 0).sort((a, b) => b[0] - a[0]);
    const cells = order.slice(0, 3).map(([, i]) => [i % N, Math.floor(i / N)] as [number, number]);
    if (cells.length > 0) return { type: 'salvo', target, cells };
  }
  if (usePower && held.includes('torpedo')) {
    let row = 0;
    let rowSum = -1;
    for (let y = 0; y < N; y++) {
      const s = d.slice(y * N, y * N + N).reduce((a, b) => a + b, 0);
      if (s > rowSum) [rowSum, row] = [s, y];
    }
    return { type: 'torpedo', target, row };
  }
  if (level === 'expert') return { type: 'fire', target, ...at(best(d, k, rand)) };
  // checkerboard hunting (Normal strays from it now and then)
  const min = Math.min(...afloat);
  const open = k.flatMap((s, i) => (s === 0 ? [i] : []));
  const parity = open.filter((i) => ((i % N) + Math.floor(i / N)) % Math.max(2, min) === 0);
  const pool = parity.length > 0 && (level === 'hard' || rand() < 0.7) ? parity : open;
  return { type: 'fire', target, ...at(pool[Math.floor(rand() * pool.length)]) };
}
