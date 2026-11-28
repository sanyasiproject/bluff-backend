// SAN text for internal moves.
import { Board, KING, PAWN, fileOf, rankOf } from './board.js';
import { F_CASTLE, F_DROP, F_EP, mFlag, mFrom, mPromo, mTo } from './movegen.js';
import { roleChar, sqName, sqParse, charRole } from './fen.js';

const up = (role: number): string => roleChar(role).toUpperCase();

// SAN without the check suffix.
export function sanCore(b: Board, m: number, legal: ArrayLike<number>, n: number): string {
  const from = mFrom(m), to = mTo(m), flag = mFlag(m), promo = mPromo(m);
  if (flag === F_CASTLE) return fileOf(to) > fileOf(from) ? 'O-O' : 'O-O-O';
  if (flag === F_DROP) return `${up(promo)}@${sqName(to)}`;
  const role = b.sq[from] & 7;
  const capture = flag === F_EP || b.sq[to] !== 0;
  let s = '';
  if (role === PAWN) {
    s = capture ? `${'abcdefgh'[fileOf(from)]}x${sqName(to)}` : sqName(to);
    if (promo) s += `=${up(promo)}`;
    return s;
  }
  s = up(role);
  let clash = false, sameFile = false, sameRank = false;
  for (let i = 0; i < n; i++) {
    const o = legal[i];
    const of = mFrom(o);
    if (of === from || mTo(o) !== to || mFlag(o) === F_DROP || mFlag(o) === F_CASTLE) continue;
    if ((b.sq[of] & 7) !== role) continue;
    clash = true;
    if (fileOf(of) === fileOf(from)) sameFile = true;
    if (rankOf(of) === rankOf(from)) sameRank = true;
  }
  if (clash) {
    if (!sameFile) s += 'abcdefgh'[fileOf(from)];
    else if (!sameRank) s += String(rankOf(from) + 1);
    else s += sqName(from);
  }
  if (capture) s += 'x';
  return s + sqName(to);
}

const clean = (san: string): string =>
  san.trim().replace(/[+#!?]+$/g, '').replace(/^0-0-0/, 'O-O-O').replace(/^0-0/, 'O-O').replace(/[!?]+/g, '');

// Finds the legal move a SAN string names, if any.
export function parseSanCore(b: Board, text: string, legal: ArrayLike<number>, n: number): number | undefined {
  const t = clean(text);
  if (!t) return undefined;
  for (let i = 0; i < n; i++) if (sanCore(b, legal[i], legal, n) === t) return legal[i];
  const drop = /^([NBRQP]?)@([a-h][1-8])$/i.exec(t);
  if (drop) {
    const role = drop[1] ? charRole(drop[1]) : PAWN;
    const to = sqParse(drop[2].toLowerCase());
    for (let i = 0; i < n; i++) {
      const m = legal[i];
      if (mFlag(m) === F_DROP && mTo(m) === to && mPromo(m) === role) return m;
    }
    return undefined;
  }
  const re = /^([NBRQK])?([a-h])?([1-8])?[x:-]?([a-h][1-8])(?:=?([NBRQK]))?$/.exec(t);
  if (!re) return undefined;
  const role = re[1] ? charRole(re[1]) : PAWN;
  const ff = re[2] ? re[2].charCodeAt(0) - 97 : -1;
  const fr = re[3] ? Number(re[3]) - 1 : -1;
  const to = sqParse(re[4]);
  const promo = re[5] ? charRole(re[5]) : 0;
  let found: number | undefined;
  for (let i = 0; i < n; i++) {
    const m = legal[i];
    const f = mFlag(m);
    if (f === F_DROP || f === F_CASTLE || mTo(m) !== to) continue;
    const from = mFrom(m);
    if ((b.sq[from] & 7) !== role) continue;
    if (ff >= 0 && fileOf(from) !== ff) continue;
    if (fr >= 0 && rankOf(from) !== fr) continue;
    if (mPromo(m) !== promo && !(promo === 0 && role !== PAWN)) continue;
    if (role === KING && promo) continue;
    if (found !== undefined) return undefined;
    found = m;
  }
  return found;
}
