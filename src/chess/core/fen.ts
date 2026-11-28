// FEN reading and writing, including X-FEN castling, pockets and check counters.
import { V_3C, V_960, V_ANTI, V_ATOM, V_HORDE, V_RK, V_ZH } from '../variants.js';
import { Board, KING, PAWN, PROMO_BIT, ROOK, fileOf, rankOf } from './board.js';
import { genLegal, mFlag, F_EP } from './movegen.js';

const ROLE_CHARS = ' pnbrqk';
export const roleChar = (role: number): string => ROLE_CHARS[role];
export const charRole = (ch: string): number => {
  const i = ROLE_CHARS.indexOf(ch.toLowerCase());
  return i > 0 ? i : 0;
};
export const sqName = (s: number): string => 'abcdefgh'[s & 7] + String((s >> 3) + 1);
export const sqParse = (t: string): number | undefined => {
  if (!/^[a-h][1-8]$/.test(t)) return undefined;
  return (t.charCodeAt(1) - 49) * 8 + (t.charCodeAt(0) - 97);
};

const pieceChar = (code: number): string => {
  const ch = ROLE_CHARS[code & 7];
  return code & 8 ? ch : ch.toUpperCase();
};

function parseBoard(b: Board, text: string): void {
  let rest = text;
  let pocketText = '';
  const br = rest.indexOf('[');
  if (br >= 0) {
    pocketText = rest.slice(br + 1, rest.indexOf(']') < 0 ? undefined : rest.indexOf(']'));
    rest = rest.slice(0, br);
  }
  const ranks = rest.split('/');
  if (ranks.length === 9) pocketText = ranks.pop() as string;
  if (ranks.length !== 8) throw new Error('bad FEN board');
  for (let i = 0; i < 8; i++) {
    const r = 7 - i;
    let f = 0;
    const row = ranks[i];
    for (let j = 0; j < row.length; j++) {
      const ch = row[j];
      if (ch >= '1' && ch <= '8') {
        f += Number(ch);
        continue;
      }
      if (ch === '~') {
        const s = r * 8 + f - 1;
        if (f > 0 && b.sq[s]) b.sq[s] |= PROMO_BIT;
        continue;
      }
      const role = charRole(ch);
      if (!role || f > 7) throw new Error('bad FEN piece');
      b.sq[r * 8 + f] = role | (ch === ch.toLowerCase() ? 8 : 0);
      f++;
    }
    if (f !== 8) throw new Error('bad FEN rank');
  }
  for (const ch of pocketText) {
    const role = charRole(ch);
    if (role && role !== KING) b.pocket[(ch === ch.toLowerCase() ? 8 : 0) + role]++;
  }
}

function parseCastling(b: Board, text: string): void {
  if (text === '-' || b.v === V_ANTI || b.v === V_RK) return;
  for (const ch of text) {
    const c = ch === ch.toLowerCase() ? 1 : 0;
    const back = c ? 56 : 0;
    const k = b.king[c];
    if (k < 0 || rankOf(k) !== (c ? 7 : 0)) continue;
    const rook = ROOK | (c << 3);
    const up = ch.toUpperCase();
    let r = -1;
    if (up === 'K') {
      for (let f = 7; f > fileOf(k); f--) if ((b.sq[back + f] & 15) === rook) { r = back + f; break; }
    } else if (up === 'Q') {
      for (let f = 0; f < fileOf(k); f++) if ((b.sq[back + f] & 15) === rook) { r = back + f; break; }
    } else if (up >= 'A' && up <= 'H') {
      const s = back + up.charCodeAt(0) - 65;
      if ((b.sq[s] & 15) === rook) r = s;
    }
    if (r < 0) continue;
    b.kingFrom[c] = k;
    b.castle[c * 2 + (fileOf(r) > fileOf(k) ? 0 : 1)] = r;
  }
}

export function parseFen(fen: string, v: number): Board {
  const b = new Board();
  b.v = v;
  const parts = fen.trim().split(/\s+/);
  parseBoard(b, parts[0] ?? '');
  b.findKings();
  b.turn = parts[1] === 'b' ? 1 : 0;
  parseCastling(b, parts[2] ?? '-');
  const ep = parts[3] && parts[3] !== '-' ? sqParse(parts[3]) : undefined;
  b.ep = -1;
  if (ep !== undefined) {
    const pawnSq = b.turn === 0 ? ep - 8 : ep + 8;
    if (pawnSq >= 0 && pawnSq < 64 && !b.sq[ep] && (b.sq[pawnSq] & 15) === (PAWN | ((b.turn ^ 1) << 3))) b.ep = ep;
  }
  let idx = 4;
  if (parts[idx] && /^\d\+\d$/.test(parts[idx])) {
    const [w, bl] = parts[idx].split('+').map(Number);
    b.checks[0] = 3 - w;
    b.checks[1] = 3 - bl;
    idx++;
  }
  b.half = parts[idx] && /^\d+$/.test(parts[idx]) ? Number(parts[idx]) : 0;
  b.full = parts[idx + 1] && /^\d+$/.test(parts[idx + 1]) ? Math.max(1, Number(parts[idx + 1])) : 1;
  for (const p of parts.slice(4)) {
    const m = /^\+(\d)\+(\d)$/.exec(p);
    if (m) {
      b.checks[0] = Number(m[1]);
      b.checks[1] = Number(m[2]);
    }
  }
  if (b.v !== V_3C) b.checks.fill(0);
  if (b.v !== V_ZH) b.pocket.fill(0);
  if (b.v === V_ATOM) {
    // A finished atomic game may have one exploded king.
    if (b.king[0] < 0 && b.king[1] < 0) throw new Error('FEN has no king');
  } else if (b.v !== V_HORDE && b.v !== V_ANTI) {
    for (let c = 0; c < 2; c++) if (b.king[c] < 0) throw new Error('FEN has no king');
  }
  b.rehash();
  return b;
}

const legalBuf = new Int32Array(512);

function epField(b: Board): string {
  if (b.ep < 0 || !b.epCapturable()) return '-';
  const n = genLegal(b, legalBuf, 0, new Board());
  for (let i = 0; i < n; i++) if (mFlag(legalBuf[i]) === F_EP) return sqName(b.ep);
  return '-';
}

function castlingField(b: Board): string {
  let out = '';
  for (let c = 0; c < 2; c++) {
    for (let side = 0; side < 2; side++) {
      const r = b.castle[c * 2 + side];
      if (r < 0) continue;
      const k = b.kingFrom[c], back = c ? 56 : 0, rook = ROOK | (c << 3);
      let outer = true;
      if (side === 0) {
        for (let f = fileOf(r) + 1; f < 8; f++) if ((b.sq[back + f] & 15) === rook) outer = false;
      } else {
        for (let f = 0; f < fileOf(r); f++) if ((b.sq[back + f] & 15) === rook) outer = false;
      }
      let ch = side === 0 ? 'K' : 'Q';
      if (!outer || (b.v !== V_960 && fileOf(k) !== 4)) ch = 'ABCDEFGH'[fileOf(r)];
      out += c ? ch.toLowerCase() : ch;
    }
  }
  return out || '-';
}

export function boardFen(b: Board): string {
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '', empty = 0;
    for (let f = 0; f < 8; f++) {
      const code = b.sq[r * 8 + f];
      if (!code) {
        empty++;
        continue;
      }
      if (empty) row += empty;
      empty = 0;
      row += pieceChar(code);
      if (code & PROMO_BIT) row += '~';
    }
    if (empty) row += empty;
    rows.push(row);
  }
  let s = rows.join('/');
  if (b.v === V_ZH) {
    let p = '';
    for (let c = 0; c < 2; c++) {
      for (const role of [5, 4, 3, 2, PAWN]) {
        const ch = c ? roleChar(role) : roleChar(role).toUpperCase();
        p += ch.repeat(b.pocket[c * 8 + role]);
      }
    }
    s += `[${p}]`;
  }
  return s;
}

export function writeFen(b: Board): string {
  let s = `${boardFen(b)} ${b.turn ? 'b' : 'w'} ${castlingField(b)} ${epField(b)} ${b.half} ${b.full}`;
  if (b.v === V_3C) s += ` +${b.checks[0]}+${b.checks[1]}`;
  return s;
}
