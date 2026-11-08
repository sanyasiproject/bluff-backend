import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import { istDay } from '../days.js';
import type { Collections, GameDoc, GamePlayerDoc, UserDoc } from '../db/documents.js';
import type { GameRecord } from '../models.js';
import { FIRST_GAME_BONUS, type CoinResult, type GameSummary } from '../types.js';

/** saves games, settles stakes, pays the first-game bonus, and adds to lifetime stats */
export class GameRecorder {
  constructor(private readonly cols: Collections) {}

  async save(record: GameRecord): Promise<CoinResult[]> {
    const finished = record.status === 'finished';
    const nameOf = new Map(record.players.map((p) => [p.memberId, p.name]));
    const players: (GamePlayerDoc & { memberId: string })[] = record.players.map((p) => ({
      memberId: p.memberId,
      userId: p.userId ? new ObjectId(p.userId) : null,
      name: p.name,
      guest: !p.userId,
      place: p.place,
      won: finished && p.place === 1 && !p.kicked,
      loser: p.loser,
      kicked: p.kicked,
      coinChange: 0,
      bonus: 0,
      stats: p.stats,
    }));

    // coins only move when the game really finished; a stopped game costs nobody anything
    const pot = finished ? await this.settleStake(players, record.config.stake) : 0;
    if (finished) await this.payFirstGameBonus(players);

    await this.cols.games.insertOne({
      _id: new ObjectId(),
      roomCode: record.roomCode,
      config: record.config,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationSec: Math.round((record.endedAt.getTime() - record.startedAt.getTime()) / 1000),
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

    const balances = await this.cols.users
      .find({ _id: { $in: players.flatMap((p) => (p.userId ? [p.userId] : [])) } }, { projection: { coins: 1 } })
      .toArray();
    const coinsOf = new Map(balances.map((u) => [u._id.toHexString(), u.coins]));
    return players.map((p) => ({
      playerId: p.memberId,
      change: p.coinChange,
      bonus: p.bonus,
      coins: p.userId ? (coinsOf.get(p.userId.toHexString()) ?? null) : null,
    }));
  }

  /** every logged-in, non-kicked player pays the stake; the winner gets the whole pot */
  private async settleStake(players: (GamePlayerDoc & { memberId: string })[], stake: number): Promise<number> {
    if (stake <= 0) return 0;
    let pot = 0;
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
    const winner = players.find((p) => p.won && p.userId);
    if (winner && pot > 0) {
      await this.cols.users.updateOne({ _id: winner.userId! }, { $inc: { coins: pot } });
      winner.coinChange += pot;
    }
    return pot;
  }

  /** +FIRST_GAME_BONUS for the first finished game of the IST day, win or lose */
  private async payFirstGameBonus(players: GamePlayerDoc[]): Promise<void> {
    const today = istDay();
    for (const p of players) {
      if (!p.userId || p.kicked) continue;
      const res = await this.cols.users.updateOne(
        { _id: p.userId, lastGameBonusDay: { $ne: today } },
        { $inc: { coins: FIRST_GAME_BONUS }, $set: { lastGameBonusDay: today } },
      );
      if (res.modifiedCount === 1) p.bonus = FIRST_GAME_BONUS;
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
        coinChange: me?.coinChange ?? 0,
        bonus: me?.bonus ?? 0,
        my: me
          ? { bluffs: me.stats.bluffs, caught: me.stats.caught, goodCalls: me.stats.goodCalls, wrongCalls: me.stats.wrongCalls, pickedUp: me.stats.pickedUp }
          : null,
        myAwards: me ? g.awards.filter((a) => a.names.includes(me.name)).map((a) => ({ emoji: a.emoji, title: a.title })) : [],
        players: g.players.map((p) => ({ name: p.name, place: p.place, loser: p.loser, guest: p.guest, kicked: p.kicked ?? false })),
      };
    });
  }
}
