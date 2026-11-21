import { ObjectId, type AnyBulkWriteOperation } from 'mongodb';
import { istDay } from '../days.js';
import type { CatchDoc, Collections, GameDoc, GamePlayerDoc, UserDoc } from '../db/documents.js';
import { HABIT_KEYS } from '../habits.js';
import type { GameRecord } from '../models.js';
import {
  DAILY_GAME_REWARDS,
  levelOf,
  MIN_REWARD_GAME_SEC,
  PASS_XP,
  missionOf,
  SECRET_XP,
  xpOf,
  type CoinResult,
  type GameSummary,
  type ReplayResponse,
  type LifetimeStats,
} from '../types.js';
import type { LeagueService } from './league.js';
import type { MissionCounts, MissionDone, MissionService } from './missions.js';
import type { RankedService } from './ranked.js';
import type { SeasonPassService } from './seasonPass.js';
import { boostOf } from './shop.js';
import { statsOf } from './users.js';

/** a friendship's key: both user ids sorted and joined, as in services/friends.ts */
const pairKey = (a: string, b: string) => [a, b].sort().join('_');

/** one game's numbers in the shape of lifetime stats */
const asLifetime = (p: GamePlayerDoc, crazy7 = false): LifetimeStats => ({
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
  crazy7Games: crazy7 ? 1 : 0,
  bonusXp: 0,
});

/** saves games, settles stakes, pays daily game rewards, counts missions, and adds to lifetime stats */
export class GameRecorder {
  constructor(
    private readonly cols: Collections,
    private readonly missions: MissionService,
    private readonly league: LeagueService,
    private readonly ranked: RankedService,
    private readonly pass?: SeasonPassService,
  ) {}

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

    // shop boosts running for each account, read once when the game ends; they only touch games that count
    const boosts = counts ? await this.boostsOf(players) : new Map<string, { xp: number; coins: number }>();
    const boostOfP = (p: GamePlayerDoc) => (p.userId ? boosts.get(p.userId.toHexString()) : undefined) ?? { xp: 1, coins: 1 };
    const boostCoins = new Map<string, number>();
    const addBoostCoins = (memberId: string, n: number) => n > 0 && boostCoins.set(memberId, (boostCoins.get(memberId) ?? 0) + n);

    // coins only move when the game really finished; a stopped game costs nobody anything
    const pot = finished ? await this.settleStake(players, record.config.stake) : 0;
    if (finished) await this.settleBets(players, record.bets);
    if (counts) await this.payDailyGameRewards(players, (p) => boostOfP(p).coins, addBoostCoins);

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
      // who caught whom lying, between logged-in players who weren't removed (for the rivals records)
      catches: finished ? this.catchesOf(players, record.catches) : [],
      winnerName: players.find((p) => p.won)?.name ?? null,
      loserName: players.find((p) => p.loser)?.name ?? null,
      awards: record.awards.map((a) => ({
        emoji: a.emoji,
        title: a.title,
        detail: a.detail,
        names: a.playerIds.map((id) => nameOf.get(id) ?? 'Someone'),
      })),
      // the step-by-step replay, when the room recorded one
      ...(record.replay && record.replay.steps.length > 0 ? { replay: record.replay } : {}),
    });

    // a secret mission card done pays bonus XP, only in a game that counts for a logged-in player who wasn't removed
    const secretDone = new Set(record.players.filter((p) => p.secret?.done).map((p) => p.memberId));
    const secretXpOf = (p: GamePlayerDoc & { memberId: string }) => (counts && p.userId && !p.kicked && secretDone.has(p.memberId) ? SECRET_XP : 0);
    // a shop XP boost adds to this game's own XP (not missions or secret cards), in a game that counts
    const boostXpOf = (p: GamePlayerDoc & { memberId: string }) =>
      counts && p.userId && !p.kicked ? Math.round(xpOf(asLifetime(p)) * (boostOfP(p).xp - 1)) : 0;

    if (finished) await this.addLifetimeStats(players, record.config.game === 'crazy7', (p) => secretXpOf(p) + boostXpOf(p));
    if (finished) await this.updateWinStreaks(players);
    // how each person really plays, for the bots; a stopped game's plays count too
    if (record.config.game !== 'crazy7') await this.addHabits(players);
    // missions move only with games that count, like the daily ladder; finished ones are paid as they're saved
    const missionsDone = counts
      ? await this.countMissions(players, record.config, secretDone, (p) => boostOfP(p).coins, addBoostCoins)
      : new Map<string, MissionDone[]>();
    // the weekly friends league counts games of 2+ logged-in people that count; never coins
    const people = players.filter((p) => p.userId && !p.kicked);
    if (counts && people.length >= 2) {
      const crazy7 = record.config.game === 'crazy7';
      await this.league
        .count(people.map((p) => ({ userId: p.userId!, won: p.won, goodCalls: crazy7 ? 0 : p.stats.goodCalls, cleanBluffs: crazy7 ? 0 : Math.max(0, p.stats.bluffs - p.stats.caught) })))
        .catch((err: Error) => console.error('[league] could not count a game:', err.message));
    }
    // a ranked Bluff table that finished and counts moves each player's rank points (Crazy 7 is never ranked)
    const ranks =
      counts && record.config.ranked && record.config.game !== 'crazy7' && people.length >= 2
        ? await this.ranked
            .rate(people.map((p) => ({ memberId: p.memberId, userId: p.userId!, won: p.won, place: p.place })), new Date(), record.config.teams)
            .catch((err: Error) => {
              console.error('[ranked] could not rate a game:', err.message);
              return new Map<string, NonNullable<CoinResult['rank']>>();
            })
        : new Map<string, NonNullable<CoinResult['rank']>>();

    // season pass XP: games that count, wins and missions finished, for logged-in people who weren't removed
    const passXp = new Map<string, number>();
    if (counts && this.pass) {
      for (const p of people) {
        const xp = PASS_XP.game + (p.won ? PASS_XP.win : 0) + PASS_XP.mission * (missionsDone.get(p.memberId)?.length ?? 0);
        try {
          await this.pass.addXp(p.userId!, xp);
          passXp.set(p.memberId, xp);
        } catch (err) {
          // a pass hiccup never costs the game's other results
          console.error('[pass] could not add XP:', (err as Error).message);
        }
      }
    }

    const today = istDay();
    const accounts = await this.cols.users
      .find(
        { _id: { $in: players.flatMap((p) => (p.userId ? [p.userId] : [])) } },
        { projection: { coins: 1, stats: 1, gamesToday: 1, gamesTodayDay: 1, winStreak: 1 } },
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
        // both already added to coins and stats.bonusXp above
        missionsDone: u ? (missionsDone.get(p.memberId) ?? []) : [],
        secretXp: u ? secretXpOf(p) : 0,
        boostXp: u ? boostXpOf(p) : 0,
        boostCoins: u ? (boostCoins.get(p.memberId) ?? 0) : 0,
        rank: u ? (ranks.get(p.memberId) ?? null) : null,
        winStreak: finished && u && !p.kicked ? (u.winStreak ?? 0) : null,
        passXp: u ? (passXp.get(p.memberId) ?? 0) : 0,
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

  /** each logged-in player's running shop boosts (1 when none) */
  private async boostsOf(players: GamePlayerDoc[]): Promise<Map<string, { xp: number; coins: number }>> {
    const ids = players.flatMap((p) => (p.userId && !p.kicked ? [p.userId] : []));
    if (ids.length === 0) return new Map();
    const now = new Date();
    const users = await this.cols.users.find({ _id: { $in: ids } }, { projection: { shop: 1 } }).toArray();
    return new Map(users.map((u) => [u._id.toHexString(), { xp: boostOf(u, 'xp', now), coins: boostOf(u, 'coins', now) }]));
  }

  /** adds one to each player's games today (IST); reaching a DAILY_GAME_REWARDS step pays its coins (more with a coin boost), win or lose */
  private async payDailyGameRewards<P extends GamePlayerDoc & { memberId: string }>(
    players: P[],
    coinBoostOf: (p: P) => number,
    onBoost: (memberId: string, extra: number) => void,
  ): Promise<void> {
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
      const base = DAILY_GAME_REWARDS.find((r) => r.games === user?.gamesToday)?.coins ?? 0;
      const reward = Math.floor(base * coinBoostOf(p));
      if (reward > 0) {
        await this.cols.users.updateOne({ _id: p.userId }, { $inc: { coins: reward } });
        p.bonus = reward;
        onBoost(p.memberId, reward - base);
      }
    }
  }

  /** a finished game: a win adds one to the win streak, anything else starts it again (logged-in players who weren't removed) */
  private async updateWinStreaks(players: GamePlayerDoc[]): Promise<void> {
    const updates: AnyBulkWriteOperation<UserDoc>[] = players
      .filter((p) => p.userId && !p.kicked)
      .map((p) => ({
        updateOne: { filter: { _id: p.userId! }, update: p.won ? { $inc: { winStreak: 1 } } : { $set: { winStreak: 0 } } },
      }));
    if (updates.length > 0) await this.cols.users.bulkWrite(updates);
  }

  /** bonusXpOf: XP from the player's secret mission card this game */
  private async addLifetimeStats<P extends GamePlayerDoc>(players: P[], crazy7: boolean, bonusXpOf: (p: P) => number): Promise<void> {
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
              'stats.crazy7Games': crazy7 ? 1 : 0,
              'stats.bonusXp': bonusXpOf(p),
            },
          },
        },
      }));
    if (updates.length > 0) await this.cols.users.bulkWrite(updates);
  }

  /** counts a game for each logged-in, non-removed player's missions; returns what each one finished, by member id */
  private async countMissions(
    players: (GamePlayerDoc & { memberId: string })[],
    config: GameRecord['config'],
    secretDone: Set<string>,
    coinBoostOf: (p: GamePlayerDoc & { memberId: string }) => number,
    onBoost: (memberId: string, extra: number) => void,
  ): Promise<Map<string, MissionDone[]>> {
    const crazy7 = config.game === 'crazy7';
    // ranked counts only where it rates: Bluff with 2+ logged-in people (bots can't sit at a ranked table)
    const counted = players.filter((p) => p.userId && !p.kicked);
    const ranked = !!config.ranked && !crazy7 && counted.length >= 2;
    // a failed friends lookup only loses this game's friends missions
    const friends = await this.friendPairs(counted.map((p) => p.userId!.toHexString())).catch((err: Error) => {
      console.error('[missions] could not read friends:', err.message);
      return new Set<string>();
    });
    const done = new Map<string, MissionDone[]>();
    for (const p of counted) {
      const me = p.userId!.toHexString();
      // another logged-in, non-removed player of this game is an accepted friend
      const withFriend = counted.some((q) => q.userId!.toHexString() !== me && friends.has(pairKey(me, q.userId!.toHexString())));
      const tally: MissionCounts = {
        games: 1,
        wins: p.won ? 1 : 0,
        goodCalls: crazy7 ? 0 : p.stats.goodCalls,
        cleanBluffs: crazy7 ? 0 : Math.max(0, p.stats.bluffs - p.stats.caught),
        crazy7Games: crazy7 ? 1 : 0,
        crazy7Wins: crazy7 && p.won ? 1 : 0,
        sevens: crazy7 ? (p.stats.sevens ?? 0) : 0,
        friendGames: withFriend ? 1 : 0,
        secrets: secretDone.has(p.memberId) ? 1 : 0,
        bluffWins: !crazy7 && p.won ? 1 : 0,
        bluffs: crazy7 ? 0 : p.stats.bluffs,
        rankedGames: ranked ? 1 : 0,
        rankedWins: ranked && p.won ? 1 : 0,
        teamWins: config.teams && !crazy7 && p.won ? 1 : 0,
        friendWins: withFriend && p.won ? 1 : 0,
        lastCalls: crazy7 ? (p.stats.lastCalls ?? 0) : 0,
        stacks: crazy7 ? (p.stats.stacks ?? 0) : 0,
      };
      try {
        const boost = coinBoostOf(p);
        const finishedNow = await this.missions.count(p.userId!, tally, undefined, boost);
        done.set(p.memberId, finishedNow);
        // the boost's share of the coins paid
        onBoost(p.memberId, finishedNow.reduce((sum, d) => sum + d.coins - (missionOf(d.id)?.coins ?? d.coins), 0));
      } catch (err) {
        // a missions hiccup never costs the game's other results
        console.error('[missions] could not count a game:', (err as Error).message);
      }
    }
    return done;
  }

  /** catches between logged-in players who weren't removed, by user id; older records have none */
  private catchesOf(players: (GamePlayerDoc & { memberId: string })[], catches: GameRecord['catches'] | undefined): CatchDoc[] {
    const userOf = new Map(players.filter((p) => p.userId && !p.kicked).map((p) => [p.memberId, p.userId!]));
    return (catches ?? []).flatMap((c) => {
      const by = userOf.get(c.by);
      const of = userOf.get(c.of);
      return by && of && c.n > 0 ? [{ by, of, n: c.n }] : [];
    });
  }

  /** pair keys of the accepted friendships among these accounts */
  private async friendPairs(userIds: string[]): Promise<Set<string>> {
    const ids = [...new Set(userIds)];
    const pairs = ids.flatMap((a, i) => ids.slice(i + 1).map((b) => pairKey(a, b)));
    if (pairs.length === 0) return new Set();
    const links = await this.cols.friends.find({ pair: { $in: pairs }, status: 'accepted' }, { projection: { pair: 1 } }).toArray();
    return new Set(links.map((f) => f.pair));
  }

  /** adds this game's true plays to each account's habits (server only; the bots read them at the next join or deal) */
  private async addHabits(players: GamePlayerDoc[]): Promise<void> {
    const updates: AnyBulkWriteOperation<UserDoc>[] = players.flatMap((p) => {
      const h = p.stats.habits;
      if (!p.userId || !h) return [];
      const inc = Object.fromEntries(HABIT_KEYS.filter((k) => h[k] > 0).map((k) => [`habits.${k}`, h[k]]));
      return Object.keys(inc).length > 0 ? [{ updateOne: { filter: { _id: p.userId }, update: { $inc: inc } } }] : [];
    });
    if (updates.length > 0) await this.cols.users.bulkWrite(updates);
  }

  /** a saved game's replay for someone who played in it (or an admin); null when it isn't theirs or has none */
  async replayFor(gameId: string, userId: ObjectId, admin: boolean): Promise<ReplayResponse | null> {
    if (!ObjectId.isValid(gameId) || !/^[0-9a-f]{24}$/i.test(gameId)) return null;
    const filter = admin ? { _id: new ObjectId(gameId) } : { _id: new ObjectId(gameId), 'players.userId': userId };
    const g = await this.cols.games.findOne(filter, { projection: { status: 1, startedAt: 1, endedAt: 1, replay: 1 } });
    if (!g?.replay) return null;
    return { id: g._id.toHexString(), status: g.status, startedAt: g.startedAt.toISOString(), endedAt: g.endedAt.toISOString(), ...g.replay };
  }

  async recentFor(userId: ObjectId, limit: number): Promise<GameSummary[]> {
    // the replay's steps stay in the database; the list only says one exists
    const games = await this.cols.games
      .find({ 'players.userId': userId }, { projection: { 'replay.steps': 0 } })
      .sort({ endedAt: -1 })
      .limit(limit)
      .toArray();
    return games.map((g: GameDoc) => {
      const me = g.players.find((p) => p.userId?.equals(userId));
      return {
        id: g._id.toHexString(),
        roomCode: g.roomCode,
        endedAt: g.endedAt.toISOString(),
        durationSec: g.durationSec,
        status: g.status,
        game: g.config.game ?? 'bluff',
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
        hasReplay: !!g.replay,
      };
    });
  }
}
