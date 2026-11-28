import type { Room } from '../../rooms.js';
import type { ChessFinish, ChessSettlement } from '../../services/chess.js';
import type { ChessColor, ChessRatingBadge, ChessPerf } from '../../types.js';
import { ChessTable } from './game.js';

/** the chess game on in this room, if any */
export const chessOf = (room: Room): ChessTable | null => (room.plugged instanceof ChessTable ? room.plugged : null);

/** what the chess service stores for a finished game */
export function chessFinishOf(room: Room, g: ChessTable): ChessFinish {
  const side = (c: ChessColor) => {
    const id = g.colors[c];
    const m = room.members.find((x) => x.id === id);
    return { userId: g.accounts[c] ?? (m && !m.bot ? m.userId : null), name: m?.name ?? g.names[id] ?? (c === 'w' ? 'White' : 'Black'), bot: g.botLevels.get(id) ?? null };
  };
  const players = { w: side('w'), b: side('b') };
  return {
    roomCode: room.code,
    variant: g.variant,
    time: g.time,
    speed: g.speed,
    perf: g.perf,
    rated: g.rated,
    players,
    result: g.result ?? { winner: null, reason: 'abort' },
    initialFen: g.initialFen,
    moves: [...g.uci],
    pgn: g.pgn({ w: players.w.name, b: players.b.name }),
    opening: g.openingName(),
    startedAt: new Date(g.startedAt),
    endedAt: new Date(),
  };
}

/** seat ratings for the people at a chess table, read once the game starts; the view shows them on the next push */
export async function loadChessBadges(g: ChessTable, read: (userIds: string[], perf: ChessPerf) => Promise<Map<string, ChessRatingBadge>>): Promise<boolean> {
  const ids = (['w', 'b'] as const).flatMap((c) => (g.accounts[c] ? [g.accounts[c]!] : []));
  if (ids.length === 0) return false;
  const badges = await read(ids, g.perf);
  for (const c of ['w', 'b'] as const) {
    const id = g.accounts[c];
    const b = id ? badges.get(id) : undefined;
    // the end result may already have landed
    if (b && !g.ratingDiff) g.ratings[c] = b;
  }
  return true;
}

/** the stored game's id, rating changes and new ratings onto the table */
export function applySettlement(g: ChessTable, s: ChessSettlement): void {
  g.gameId = s.gameId;
  g.ratingDiff = s.diff;
  for (const c of ['w', 'b'] as const) if (s.ratings[c]) g.ratings[c] = s.ratings[c];
}
