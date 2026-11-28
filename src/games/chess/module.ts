import { GameError } from '../../game.js';
import type { GameEvent } from '../../models.js';
import type { AnnounceKind, ChessColor, ChessEndReason, ChessMoveInput } from '../../types.js';
import type { GameModule } from '../module.js';
import { ChessTable, CHESS_TIMING, type ChessTally } from './game.js';
import { chessBots } from './pool.js';
import { botBudgetMs } from './budget.js';
import type { ThinkJob } from './think.js';

/** a game:move payload's chess part (see ChessMoveInput) */
export function parseChessMove(raw: unknown): ChessMoveInput {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  switch (p.type) {
    case 'move':
      if (typeof p.uci !== 'string' || !/^([a-h][1-8][a-h][1-8][qrbnk]?|[PNBRQK]@[a-h][1-8])$/.test(p.uci)) throw new GameError('Invalid move');
      if (!Number.isInteger(p.ply) || (p.ply as number) < 0) throw new GameError('Invalid move');
      return { type: 'move', uci: p.uci, ply: p.ply as number };
    case 'resign':
    case 'abort':
    case 'claimTimeout':
      return { type: p.type };
    case 'draw':
      if (typeof p.offer !== 'boolean') throw new GameError('Invalid move');
      return { type: 'draw', offer: p.offer };
    case 'takeback':
      if (p.accept !== undefined && typeof p.accept !== 'boolean') throw new GameError('Invalid move');
      return p.accept === undefined ? { type: 'takeback' } : { type: 'takeback', accept: p.accept };
    default:
      throw new GameError('Invalid move');
  }
}

const COLOR_NAME: Record<ChessColor, string> = { w: 'White', b: 'Black' };
const REASON: Record<ChessEndReason, string> = {
  checkmate: 'Checkmate',
  stalemate: 'Stalemate',
  insufficient: 'Insufficient material',
  threefold: 'Threefold repetition',
  fiftyMove: '50-move rule',
  variantWin: 'Variant win',
  variantLoss: 'Variant loss',
  kingOfTheHill: 'King in the centre',
  threeCheck: 'Third check',
  atomicExplosion: 'King exploded',
  hordeDestroyed: 'Horde destroyed',
  raceFinished: 'Race finished',
  resign: 'Resignation',
  timeout: 'Time out',
  agreement: 'Draw agreed',
  abort: 'Game aborted',
};

function describe(g: ChessTable, e: GameEvent, n: (id: string | null) => string): [AnnounceKind, string] | null {
  if (e.kind === 'gameOver') {
    const r = g.result;
    if (!r || r.reason === 'abort') return ['over', 'Game aborted. Nothing counts'];
    if (!r.winner) return ['over', `${REASON[r.reason]}. It's a draw 🤝`];
    return ['over', `${REASON[r.reason]}. ${n(g.colors[r.winner])} wins with ${COLOR_NAME[r.winner]} 🎉`];
  }
  if (e.kind !== 'chess' || e.ev.type !== 'offer') return null;
  const who = n(e.ev.playerId);
  const what = e.ev.offer === 'draw' ? 'a draw' : 'a takeback';
  if (e.ev.answer === 'ask') return ['room', `${who} offers ${what}`];
  if (e.ev.answer === 'no') return ['room', `${who} declined ${what}`];
  return e.ev.offer === 'takeback' ? ['room', `${who} accepted the takeback`] : null;
}

/** what a bot thinks about: the game so far and how long it may take */
export function jobOf(g: ChessTable, botId: string, seed: number): ThinkJob {
  const level = g.botLevels.get(botId) ?? 3;
  const c = g.colorOf(botId)!;
  return { variant: g.variant, initialFen: g.initialFen, moves: [...g.uci], level, maxMs: botBudgetMs(level, g.timeLeft(c), g.inc), seed };
}

export const chessModule: GameModule<ChessTable> = {
  kind: 'chess',
  create: (order, config, rand, botIds) => new ChessTable(order, config, rand, botIds),
  onStart: (g, seats) => g.seat(seats),
  view: (g) => ({ kind: 'chess', chess: g.view() }),
  move(g, playerId, raw) {
    const m = parseChessMove(raw);
    switch (m.type) {
      case 'move':
        return g.play(playerId, m.uci, m.ply);
      case 'resign':
        return g.resign(playerId);
      case 'abort':
        return g.abort(playerId);
      case 'draw':
        return g.draw(playerId, m.offer);
      case 'takeback':
        return g.takeback(playerId, m.accept);
      case 'claimTimeout':
        if (!g.colorOf(playerId)) throw new GameError("You're not playing this game");
        return g.checkTimers();
    }
  },
  describe,
  // bots answer offers made to them: takebacks yes, draws no
  auto(g) {
    if (g.over) return null;
    const botAsked = (offer: ChessColor | null) => offer && g.botLevels.has(g.colors[offer === 'w' ? 'b' : 'w']);
    if (botAsked(g.takebackOffer)) {
      const bot = g.colors[g.takebackOffer === 'w' ? 'b' : 'w'];
      return { delayMs: CHESS_TIMING.botAnswerMs, run: () => g.takeback(bot, true) };
    }
    if (botAsked(g.drawOffer)) {
      const bot = g.colors[g.drawOffer === 'w' ? 'b' : 'w'];
      return { delayMs: CHESS_TIMING.botAnswerMs, run: () => g.draw(bot, false) };
    }
    return null;
  },
  // the flag and the first-move abort, re-armed after every move
  clock(g) {
    if (g.over) return null;
    if (g.abortAt !== null) return { endsAt: g.abortAt, key: `a${g.stepSeq}`, run: () => g.checkTimers() };
    const left = g.timeLeft(g.turn);
    if (left === null || g.runningSince === null) return null;
    return { endsAt: g.now() + left, key: `c${g.stepSeq}`, run: () => g.checkTimers() };
  },
  ownClock: true,
  // bullet premoves come quickly
  moveRate: 60,
  // chess bots only think in the worker pool (botThink); with ownClock nothing asks for a stand-in move
  botMove: () => {
    throw new GameError('Chess bots think off the main thread');
  },
  async botThink(g, botId, rand) {
    const job = jobOf(g, botId, Math.floor(rand() * 2 ** 31));
    const left = g.timeLeft(g.colorOf(botId)!);
    const started = Date.now();
    const ply = g.uci.length;
    const uci = await chessBots().think(job);
    // never instant: a short pause, shorter as the bot's clock runs down
    const pause = Math.min(CHESS_TIMING.botMinMs, left === null ? Infinity : left / 40) - (Date.now() - started);
    if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    return { type: 'move', uci, ply };
  },
  turnKey: (g) => `${g.stepSeq}|${g.uci.length}`,
  inPlay: (g, id) => g.inPlay(id),
  tallies: (g, id) => ({ ...((g.stats.get(id)?.tallies as ChessTally | undefined) ?? {}) }),
  missionCounts: () => ({}),
};
