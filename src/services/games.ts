import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import type { Collections, GameDoc, UserDoc } from '../db/documents.js';
import type { GameRecord } from '../models.js';
import type { GameSummary } from '../types.js';

/** saves finished games and adds them to each logged-in player's lifetime stats */
export class GameRecorder {
  constructor(private readonly cols: Collections) {}

  async save(record: GameRecord): Promise<void> {
    const finished = record.status === 'finished';
    const nameOf = new Map(record.players.map((p) => [p.memberId, p.name]));
    const players = record.players.map((p) => ({
      userId: p.userId ? new ObjectId(p.userId) : null,
      name: p.name,
      guest: !p.userId,
      place: p.place,
      won: finished && p.place === 1,
      loser: p.loser,
      stats: p.stats,
    }));

    await this.cols.games.insertOne({
      _id: new ObjectId(),
      roomCode: record.roomCode,
      config: record.config,
      status: record.status,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      durationSec: Math.round((record.endedAt.getTime() - record.startedAt.getTime()) / 1000),
      players,
      winnerName: players.find((p) => p.won)?.name ?? null,
      loserName: players.find((p) => p.loser)?.name ?? null,
      awards: record.awards.map((a) => ({ emoji: a.emoji, title: a.title, detail: a.detail, names: a.playerIds.map((id) => nameOf.get(id) ?? 'Someone') })),
    });

    // games the host ended early are kept for history but don't count as wins or losses
    if (!finished) return;
    const updates: AnyBulkWriteOperation<UserDoc>[] = players
      .filter((p) => p.userId)
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
        status: g.status,
        place: me?.place ?? null,
        won: me?.won ?? false,
        lost: me?.loser ?? false,
        players: g.players.map((p) => ({ name: p.name, place: p.place, loser: p.loser, guest: p.guest })),
      };
    });
  }
}
