// Chess variants: ids, names and one-line explanations.
export type ChessVariant =
  | 'standard'
  | 'chess960'
  | 'crazyhouse'
  | 'kingOfTheHill'
  | 'threeCheck'
  | 'antichess'
  | 'atomic'
  | 'horde'
  | 'racingKings';

export const CHESS_VARIANTS: readonly { id: ChessVariant; name: string; short: string; about: string }[] = [
  { id: 'standard', name: 'Standard', short: 'STD', about: 'Classic chess with the usual rules.' },
  { id: 'chess960', name: 'Chess960', short: '960', about: 'The back rank is shuffled; castling still lands on the usual squares.' },
  { id: 'crazyhouse', name: 'Crazyhouse', short: 'ZH', about: 'Captured pieces change sides and can be dropped back onto the board.' },
  { id: 'kingOfTheHill', name: 'King of the Hill', short: 'KOTH', about: 'Bring your king to one of the four centre squares to win.' },
  { id: 'threeCheck', name: 'Three-check', short: '3+', about: 'Give check three times to win.' },
  { id: 'antichess', name: 'Antichess', short: 'ANTI', about: 'Captures are forced; lose all your pieces (or get stalemated) to win.' },
  { id: 'atomic', name: 'Atomic', short: 'ATOM', about: 'Captures explode nearby pieces; blow up the enemy king to win.' },
  { id: 'horde', name: 'Horde', short: 'HRD', about: 'White has 36 pawns and no king; Black must capture them all.' },
  { id: 'racingKings', name: 'Racing Kings', short: 'RACE', about: 'No checks allowed; the first king to reach the 8th rank wins.' },
];

export const isChessVariant = (v: unknown): v is ChessVariant =>
  typeof v === 'string' && CHESS_VARIANTS.some((x) => x.id === v);

// Numeric variant ids used internally.
export const V_STD = 0, V_960 = 1, V_ZH = 2, V_KOTH = 3, V_3C = 4, V_ANTI = 5, V_ATOM = 6, V_HORDE = 7, V_RK = 8;
const VARIANT_IDS: readonly ChessVariant[] = [
  'standard', 'chess960', 'crazyhouse', 'kingOfTheHill', 'threeCheck', 'antichess', 'atomic', 'horde', 'racingKings',
];
export const variantNum = (v: ChessVariant): number => {
  const i = VARIANT_IDS.indexOf(v);
  if (i < 0) throw new Error(`unknown chess variant ${v}`);
  return i;
};
export const variantOf = (n: number): ChessVariant => VARIANT_IDS[n];

export const STANDARD_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
export const HORDE_FEN = 'rnbqkbnr/pppppppp/8/1PP2PP1/PPPPPPPP/PPPPPPPP/PPPPPPPP/PPPPPPPP w kq - 0 1';
export const RACING_KINGS_FEN = '8/8/8/8/8/8/krbnNBRK/qrbnNBRQ w - - 0 1';
export const ANTICHESS_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1';

// Back rank (white, a..h) for Chess960 start number 0..959; 518 is the standard setup.
export function chess960BackRank(n: number): string {
  let k = ((Math.floor(n) % 960) + 960) % 960;
  const rank: string[] = new Array(8).fill('');
  rank[(k % 4) * 2 + 1] = 'B';
  k = Math.floor(k / 4);
  rank[(k % 4) * 2] = 'B';
  k = Math.floor(k / 4);
  const free = () => rank.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
  rank[free()[k % 6]] = 'Q';
  k = Math.floor(k / 6);
  const knights = [[0, 1], [0, 2], [0, 3], [0, 4], [1, 2], [1, 3], [1, 4], [2, 3], [2, 4], [3, 4]][k];
  const f = free();
  rank[f[knights[0]]] = 'N';
  rank[f[knights[1]]] = 'N';
  const rest = free();
  rank[rest[0]] = 'R';
  rank[rest[1]] = 'K';
  rank[rest[2]] = 'R';
  return rank.join('');
}

export function startFen(variant: ChessVariant, seed960 = 518): string {
  switch (variant) {
    case 'chess960': {
      const r = chess960BackRank(seed960);
      return `${r.toLowerCase()}/pppppppp/8/8/8/8/PPPPPPPP/${r} w KQkq - 0 1`;
    }
    case 'crazyhouse':
      return 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR[] w KQkq - 0 1';
    case 'threeCheck':
      return `${STANDARD_FEN} +0+0`;
    case 'antichess':
      return ANTICHESS_FEN;
    case 'horde':
      return HORDE_FEN;
    case 'racingKings':
      return RACING_KINGS_FEN;
    default:
      return STANDARD_FEN;
  }
}
