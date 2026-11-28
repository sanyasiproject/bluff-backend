import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { isBlocked } from './blocklist.js';

/**
 * The English word list: SCOWL (Kevin Atkinson, permissive licence; levels 10–70) via the npm package
 * wordlist-english 1.2.1 (MIT). Lowercase a–z, 3–16 letters, blocklist removed; server only.
 */
export const DICT_SOURCE = 'SCOWL levels 10–70 via wordlist-english@1.2.1 (MIT; SCOWL permissive licence)';
/** SCOWL levels: lower is more common; a word's tier is its level's place here + 1 */
export const DICT_LEVELS = [10, 20, 35, 40, 50, 55, 60, 70] as const;

/** a compact trie: node 0 is the root; children are a sibling chain sorted by letter */
export interface Dict {
  /** letter code 0..25 of the edge into each node */
  letter: Uint8Array;
  firstChild: Int32Array;
  nextSibling: Int32Array;
  /** 0 not a word; else 1 (most common) .. 8 (rare) */
  tier: Uint8Array;
  words: number;
  nodes: number;
  /** load figures for the logs and the tests */
  loadMs: number;
  heapMb: number;
  bytes: number;
}

let loaded: Dict | null = null;

/** the raw words with their tier, from the package's files */
export function readWordList(): Map<string, number> {
  const dir = dirname(createRequire(import.meta.url).resolve('wordlist-english/package.json'));
  const out = new Map<string, number>();
  for (const f of readdirSync(dir)) {
    const m = /^(english|american|british|canadian|australian)-words-(\d+)\.json$/.exec(f);
    if (!m) continue;
    const tier = DICT_LEVELS.indexOf(Number(m[2]) as (typeof DICT_LEVELS)[number]) + 1;
    if (tier <= 0) continue;
    for (const w of JSON.parse(readFileSync(join(dir, f), 'utf8')) as string[]) {
      if (!/^[a-z]{3,16}$/.test(w) || isBlocked(w)) continue;
      const had = out.get(w);
      if (had === undefined || tier < had) out.set(w, tier);
    }
  }
  return out;
}

/** builds the trie from words (any order) */
export function buildDict(list: Map<string, number>): Omit<Dict, 'loadMs' | 'heapMb'> {
  const words = [...list.keys()].sort();
  const letter: number[] = [0];
  const first: number[] = [-1];
  const next: number[] = [-1];
  const tier: number[] = [0];
  const lastChild: number[] = [-1];
  for (const w of words) {
    let node = 0;
    for (let i = 0; i < w.length; i++) {
      const c = w.charCodeAt(i) - 97;
      // sorted input: a new child always goes last in its parent's chain
      const lc = lastChild[node];
      if (lc >= 0 && letter[lc] === c) node = lc;
      else {
        const n = letter.length;
        letter.push(c);
        first.push(-1);
        next.push(-1);
        tier.push(0);
        lastChild.push(-1);
        if (lc >= 0) next[lc] = n;
        else first[node] = n;
        lastChild[node] = n;
        node = n;
      }
    }
    tier[node] = list.get(w)!;
  }
  const d = { letter: Uint8Array.from(letter), firstChild: Int32Array.from(first), nextSibling: Int32Array.from(next), tier: Uint8Array.from(tier), words: words.length, nodes: letter.length, bytes: 0 };
  d.bytes = d.letter.byteLength + d.firstChild.byteLength + d.nextSibling.byteLength + d.tier.byteLength;
  return d;
}

/** the dictionary, loaded on first use and kept */
export function dictionary(): Dict {
  if (loaded) return loaded;
  const t0 = performance.now();
  const h0 = process.memoryUsage().heapUsed;
  const built = buildDict(readWordList());
  loaded = { ...built, loadMs: Math.round(performance.now() - t0), heapMb: Math.round(((process.memoryUsage().heapUsed - h0) / 1048576) * 10) / 10 };
  return loaded;
}

/** the child of node by letter code, or -1 */
export function childOf(d: Dict, node: number, c: number): number {
  for (let k = d.firstChild[node]; k >= 0; k = d.nextSibling[k]) {
    if (d.letter[k] === c) return k;
    if (d.letter[k] > c) return -1;
  }
  return -1;
}

/** the node a string ends at, or -1 */
export function nodeOf(d: Dict, s: string, from = 0): number {
  let n = from;
  for (let i = 0; i < s.length && n >= 0; i++) n = childOf(d, n, s.charCodeAt(i) - 97);
  return n;
}

/** a word's tier (1 common .. 8 rare), or 0 when it isn't a word */
export function tierOf(d: Dict, word: string): number {
  if (!/^[a-z]{3,16}$/.test(word)) return 0;
  const n = nodeOf(d, word);
  return n < 0 ? 0 : d.tier[n];
}

export const isWord = (d: Dict, word: string): boolean => tierOf(d, word) > 0;
