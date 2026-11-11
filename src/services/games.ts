import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import { istDay } from '../days.js';
import type { Collections, GameDoc, GamePlayerDoc, UserDoc } from '../db/documents.js';
import type { GameRecord } from '../models.js';
import {
  DAILY_GAME_REWARDS,
  levelOf,
  MIN_REWARD_GAME_SEC,
  xpOf,
  type CoinResult,
  type GameSummary,
  type LifetimeStats,
} from '../types.js';
import { statsOf } from './users.js';

/** one game's numbers in the shape of lifetime stats */
const asLifetime = (p: GamePlayerDoc): LifetimeStats => ({
  gamesPlayed: 1,
  wins: p.won ? 1 : 0,
  losses: p.loser ? 1 : 0,
  bluffs: p.stats.bluffs,
  bluffsCaught: p.stats.caught,
  goodCalls: p.stats.goodCalls,
  wrongCalls: p.stats.wrongCalls,
  cardsPickedUp: p.stats.pickedUp,
  plays: p.stats.plays ?? 0,
  chances: p.stats.chances ?? 0,
});

/** saves games, settles stakes, pays daily game rewards, and adds to lifetime stats */
export class GameRecorder {
  constructor(private readonly cols: Collections) {}

  async save(record: GameRecord): Promise<CoinResult[]> {
    const finished = record.status === 'finished';
    const durationSec = Math.round((record.endedAt.getTime() - record.startedAt.getTime()) / 1000);
    // only real games count towards the daily rewards: finished and long enough
    const counts = finished && durationSec >= MIN_REWARD_GAME_SEC;
    const nameOf = new Map(record.players.map((p) => [p.memberId, p.name]));
    const players: (GamePlayerDoc & { memberId: string })[] = record.players.map((p) => ({
      memberId: p.memberId,
      userId: p.userId ? new ObjectId(p.userId) : null,
      name: p.name,
      guest: !p.userId && !p.bot,
      bot: p.bot,
      place: p.place,
      won: finished && p.won && !p.kicked,
      loser: p.loser,
      kicked: p.kicked,
      coinChange: 0,
      bonus: 0,
      betChange: 0,
      stats: p.stats,
    }));

    // coins only move when the game really finished; a stopped game costs nobody anything
    const pot = finished ? await this.settleStake(players, record.config.stake) : 0;
    if (finished) await this.settleBets(players, record.bets);
    if (counts) await this.payDailyGameRewards(players);

    await this.cols.games.insertOne({
      _id: new ObjectId(),
      roomCode: record.roomCode,
      config: record.config,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationSec,
      stake: record.config.stake,
      pot,
      players: players.map(({ memberId: _memberId, ...p }) => p),
      winnerName: players.find((p) => p.won)?.name ?? null,
      loserName: players.find((p) => p.loser)?.name ?? null,
      awards: record.awards.map((a) => ({
        emoji: a.emoji,
        title: a.title,
        detail: a.detail,
        names: a.playerIds.map((id) => nameOf.get(id) ?? 'Someone'),
      })),
    });

    if (finished) await this.addLifetimeStats(players);

    const today = istDay();
    const accounts = await this.cols.users
      .find(
        { _id: { $in: players.flatMap((p) => (p.userId ? [p.userId] : [])) } },
        { projection: { coins: 1, stats: 1, gamesToday: 1, gamesTodayDay: 1 } },
      )
      .toArray();
    const byId = new Map(accounts.map((u) => [u._id.toHexString(), u]));
    return players.map((p) => {
      const u = p.userId ? byId.get(p.userId.toHexString()) : undefined;
      return {
        playerId: p.memberId,
        change: p.coinChange,
        bonus: p.bonus,
        coins: u?.coins ?? null,
        level: u ? levelOf(statsOf(u)) : null,
        gamesToday: u ? (u.gamesTodayDay === today ? (u.gamesToday ?? 0) : 0) : null,
        counted: counts && !!u && !p.kicked,
        bets: p.betChange ?? 0,
        // same rule as addLifetimeStats: finished games of logged-in players who weren't removed
        xp: finished && u && !p.kicked ? xpOf(asLifetime(p)) : 0,
      };
    });
  }

  /** every logged-in, non-kicked player pays the stake; the winner gets the whole pot */
  private async settleStake(players: (GamePlayerDoc & { memberId: string })[], stake: number): Promise<number> {
    if (stake <= 0) return 0;
    // bots have no coins, but their seats still count: a person who wins takes the stake for every seat
    let pot = stake * players.filter((p) => p.bot && !p.kicked).length;
    for (const p of players) {
      if (!p.userId || p.kicked) continue;
      // never below zero: take the stake, or what's left if an admin removed coins mid-game
      const before = await this.cols.users.findOneAndUpdate(
        { _id: p.userId },
        [{ $set: { coins: { $max: [0, { $subtract: ['$coins', stake] }] } } }],
        { returnDocument: 'before', projection: { coins: 1 } },
      );
      const paid = Math.min(before?.coins ?? 0, stake);
      p.coinChange -= paid;
      pot += paid;
    }
    // one winner takes it all; a winning 2v2 team splits it (any odd coin goes to the first). A bot's share just goes
    const winners = players.filter((p) => p.won);
    for (const [i, w] of winners.entries()) {
      const share = Math.floor(pot / winners.length) + (i === 0 ? pot % winners.length : 0);
      if (share === 0 || !w.userId) continue;
      await this.cols.users.updateOne({ _id: w.userId! }, { $inc: { coins: share } });
      w.coinChange += share;
    }
    return pot;
  }

  /** each bet's loser pays the winner, never below zero; bets with a removed or guest player don't count.
   * Bots have no coins: what a person loses to a bot is gone, what they win from one is new */
  private async settleBets(players: (GamePlayerDoc & { memberId: string })[], bets: GameRecord['bets']): Promise<void> {
    const byMember = new Map(players.map((p) => [p.memberId, p]));
    const counts = (p: GamePlayerDoc | undefined): p is GamePlayerDoc => !!p && !p.kicked && (!!p.userId || !!p.bot);
    for (const bet of bets) {
      const from = byMember.get(bet.from);
      const to = byMember.get(bet.to);
      if (!counts(from) || !counts(to) || (from.bot && to.bot)) continue;
      let paid = bet.amount;
      if (from.userId) {
        const before = await this.cols.users.findOneAndUpdate(
          { _id: from.userId },
          [{ $set: { coins: { $max: [0, { $subtract: ['$coins', bet.amount] }] } } }],
          { returnDocument: 'before', projection: { coins: 1 } },
        );
        paid = Math.min(before?.coins ?? 0, bet.amount);
        if (paid === 0) continue;
        from.betChange = (from.betChange ?? 0) - paid;
      }
      if (to.userId) {
        await this.cols.users.updateOne({ _id: to.userId }, { $inc: { coins: paid } });
        to.betChange = (to.betChange ?? 0) + paid;
      }
    }
  }

  /** adds one to each player's games today (IST); reaching a DAILY_GAME_REWARDS step pays its coins, win or lose */
  private async payDailyGameRewards(players: GamePlayerDoc[]): Promise<void> {
    const today = istDay();
    for (const p of players) {
      if (!p.userId || p.kicked) continue;
      // one atomic step: a new day restarts the count, so each count is reached once a day
      const user = await this.cols.users.findOneAndUpdate(
        { _id: p.userId },
        [
          {
            $set: {
              gamesToday: { $cond: [{ $eq: ['$gamesTodayDay', today] }, { $add: [{ $ifNull: ['$gamesToday', 0] }, 1] }, 1] },
              gamesTodayDay: today,
            },
          },
        ],
        { returnDocument: 'after', projection: { gamesToday: 1 } },
      );
      const reward = DAILY_GAME_REWARDS.find((r) => r.games === user?.gamesToday)?.coins ?? 0;
      if (reward > 0) {
        await this.cols.users.updateOne({ _id: p.userId }, { $inc: { coins: reward } });
        p.bonus = reward;
      }
    }
  }

  private async addLifetimeStats(players: GamePlayerDoc[]): Promise<void> {
    const updates: AnyBulkWriteOperation<UserDoc>[] = players
      .filter((p) => p.userId && !p.kicked)
      .map((p) => ({
        updateOne: {
          filter: { _id: p.userId! },
          update: {
            $inc: {
              'stats.gamesPlayed': 1,
              'stats.wins': p.won ? 1 : 0,
              'stats.losses': p.loser ? 1 : 0,
              'stats.bluffs': p.stats.bluffs,
              'stats.bluffsCaught': p.stats.caught,
              'stats.goodCalls': p.stats.goodCalls,
              'stats.wrongCalls': p.stats.wrongCalls,
              'stats.cardsPickedUp': p.stats.pickedUp,
              'stats.plays': p.stats.plays ?? 0,
              'stats.chances': p.stats.chances ?? 0,
            },
          },
        },
      }));
    if (updates.length > 0) await this.cols.users.bulkWrite(updates);
  }

  async recentFor(userId: ObjectId, limit: number): Promise<GameSummary[]> {
    const games = await this.cols.games.find({ 'players.userId': userId }).sort({ endedAt: -1 }).limit(limit).toArray();
    return games.map((g: GameDoc) => {
      const me = g.players.find((p) => p.userId?.equals(userId));
      return {
        id: g._id.toHexString(),
        roomCode: g.roomCode,
        endedAt: g.endedAt.toISOString(),
        durationSec: g.durationSec,
        status: g.status,
        decks: g.config.decks,
        stake: g.stake ?? 0,
        place: me?.place ?? null,
        won: me?.won ?? false,
        lost: me?.loser ?? false,
        kicked: me?.kicked ?? false,
        // stake and bets together
        coinChange: (me?.coinChange ?? 0) + (me?.betChange ?? 0),
        bonus: me?.bonus ?? 0,
        my: me
          ? { bluffs: me.stats.bluffs, caught: me.stats.caught, goodCalls: me.stats.goodCalls, wrongCalls: me.stats.wrongCalls, pickedUp: me.stats.pickedUp }
          : null,
        myAwards: me ? g.awards.filter((a) => a.names.includes(me.name)).map((a) => ({ emoji: a.emoji, title: a.title })) : [],
        players: g.players.map((p) => ({ name: p.name, place: p.place, loser: p.loser, guest: p.guest, kicked: p.kicked ?? false, bot: p.bot ?? false })),
      };
    });
  }
}
