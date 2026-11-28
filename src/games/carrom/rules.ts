import { freeSpot, type CarromCoin, type CarromResult } from '../../carrom/index.js';
import { CARROM_RULES, type CarromFoul, type CarromMode } from '../../types.js';

export type QueenState = { state: 'board' | 'pending' | 'covered'; by: string | null };

/** what a shot did under the rules */
export interface CarromOutcome {
  /** coins on the board after the rules put any back */
  coins: CarromCoin[];
  queen: QueenState;
  foul: CarromFoul | null;
  queenNote: 'pocketed' | 'covered' | 'returned' | null;
  returned: string[];
  /** Freestyle points (foul included) */
  points: number;
  again: boolean;
  /** coins that stay pocketed: the shooter's own (Freestyle: every coin) and the other side's */
  kept: string[];
  given: string[];
  /** Classic: the colour that has cleared the board; Freestyle: 'all' once no coin is left */
  cleared: 'w' | 'b' | 'all' | null;
}

const colorOfId = (id: string): 'w' | 'b' | 'q' => (id === 'Q' ? 'q' : id[0] === 'W' ? 'w' : 'b');
const ALL_IDS = [...Array.from({ length: 9 }, (_, i) => `W${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `B${i + 1}`)];

/** puts coins back round the centre, each on a free spot */
function putBack(coins: CarromCoin[], ids: string[]): void {
  for (const id of ids) {
    if (coins.some((c) => c.id === id)) continue;
    const [x, y] = freeSpot(coins);
    coins.push({ id, c: colorOfId(id), x, y });
  }
}

/**
 * the rules for one shot. me: the shooter; color: their Classic colour (null in Freestyle).
 * startCoins: the board before the shot (to know what was already pocketed)
 */
export function resolveShot(mode: CarromMode, me: string, color: 'w' | 'b' | null, startCoins: readonly CarromCoin[], queen0: QueenState, res: CarromResult): CarromOutcome {
  const coins = res.coins.map((c) => ({ ...c }));
  const queen: QueenState = { ...queen0 };
  const P = res.pocketed;
  let foul: CarromFoul | null = res.striker.pocketed ? 'striker' : res.firstHit === null ? 'miss' : null;
  let note: CarromOutcome['queenNote'] = null;
  const returned: string[] = [];
  const back = (ids: string[]) => {
    for (const id of ids) if (!returned.includes(id)) returned.push(id);
  };
  const queenIn = P.includes('Q');
  const coinsIn = P.filter((id) => id !== 'Q');
  if (mode === 'freestyle') {
    let points = 0;
    for (const id of coinsIn) points += colorOfId(id) === 'w' ? CARROM_RULES.points.w : CARROM_RULES.points.b;
    // the queen I pocketed last shot: covered by any coin now, else she goes back
    if (queen.state === 'pending' && queen.by === me) {
      if (!foul && coinsIn.length > 0) {
        Object.assign(queen, { state: 'covered', by: me });
        note = 'covered';
        points += CARROM_RULES.points.q;
      } else {
        Object.assign(queen, { state: 'board', by: null });
        note = 'returned';
        back(['Q']);
      }
    }
    if (queenIn) {
      if (foul) {
        note = 'returned';
        back(['Q']);
      } else if (coinsIn.length > 0 || coins.length === 0) {
        Object.assign(queen, { state: 'covered', by: me });
        note = 'covered';
        points += CARROM_RULES.points.q;
      } else {
        Object.assign(queen, { state: 'pending', by: me });
        note = 'pocketed';
      }
    }
    if (foul) points -= CARROM_RULES.foul;
    putBack(coins, returned);
    const again = !foul && P.length > 0;
    return { coins, queen, foul, queenNote: note, returned, points, again, kept: P.filter((id) => !returned.includes(id)), given: [], cleared: coins.length === 0 && queen.state !== 'pending' ? 'all' : null };
  }
  const mine = color!;
  const theirs = mine === 'w' ? 'b' : 'w';
  const ownIn = coinsIn.filter((id) => colorOfId(id) === mine);
  const oppIn = coinsIn.filter((id) => colorOfId(id) === theirs);
  const ownOffBefore = ALL_IDS.filter((id) => colorOfId(id) === mine && !startCoins.some((c) => c.id === id)).length;
  if (queen.state === 'pending' && queen.by === me) {
    if (!foul && ownIn.length > 0) {
      Object.assign(queen, { state: 'covered', by: me });
      note = 'covered';
    } else {
      Object.assign(queen, { state: 'board', by: null });
      note = 'returned';
      back(['Q']);
    }
  }
  if (queenIn) {
    if (foul || (ownIn.length === 0 && ownOffBefore === 0)) {
      // a foul, or the queen before any coin of my own: she goes back
      note = 'returned';
      back(['Q']);
    } else if (ownIn.length > 0) {
      Object.assign(queen, { state: 'covered', by: me });
      note = 'covered';
    } else {
      Object.assign(queen, { state: 'pending', by: me });
      note = 'pocketed';
    }
  }
  // a side's last coin can't go before the queen is covered: it comes back, and it's my foul
  if (queen.state !== 'covered') {
    for (const [c, list] of [[mine, ownIn], [theirs, oppIn]] as const) {
      if (list.length > 0 && !coins.some((k) => k.c === c)) {
        back([list[list.length - 1]]);
        foul = foul ?? 'lastCoin';
      }
    }
  }
  if (foul) {
    // the penalty: one of my pocketed coins back to the centre
    const off = ALL_IDS.filter((id) => colorOfId(id) === mine && !coins.some((c) => c.id === id) && !returned.includes(id));
    if (off.length > 0) back([off[off.length - 1]]);
  }
  putBack(coins, returned);
  const again = !foul && (ownIn.some((id) => !returned.includes(id)) || note === 'pocketed' || note === 'covered');
  let cleared: CarromOutcome['cleared'] = null;
  if (queen.state === 'covered') {
    const myLeft = coins.some((c) => c.c === mine);
    const theirLeft = coins.some((c) => c.c === theirs);
    cleared = !myLeft ? mine : !theirLeft ? theirs : null;
  }
  return {
    coins,
    queen,
    foul,
    queenNote: note,
    returned,
    points: 0,
    again,
    kept: [...ownIn, ...(queenIn && !returned.includes('Q') ? ['Q'] : [])].filter((id) => !returned.includes(id)),
    given: oppIn.filter((id) => !returned.includes(id)),
    cleared,
  };
}

/** Classic board points for the side that cleared: the other side's coins left, plus the queen if the winner covered her */
export function boardPoints(coins: readonly CarromCoin[], winner: 'w' | 'b', queenByWinner: boolean): number {
  const loser = winner === 'w' ? 'b' : 'w';
  return coins.filter((c) => c.c === loser).length + (queenByWinner ? CARROM_RULES.queenBonus : 0);
}
