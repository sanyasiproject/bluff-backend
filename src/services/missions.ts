import { createHash } from 'node:crypto';
import type { Filter, ObjectId, UpdateFilter } from 'mongodb';
import { istDay, istWeek, nextIstDay, nextIstWeek } from '../days.js';
import type { Collections, MissionDoc, MissionsDoc, UserDoc } from '../db/documents.js';
import { ApiError } from '../http/errors.js';
import {
  MISSIONS,
  MISSIONS_PER_SET,
  missionOf,
  type MissionCounter,
  type MissionPeriod,
  type MissionsResponse,
  type MissionView,
} from '../types.js';

/** a write that lost to another one is tried again, up to this many tries in all */
const MAX_TRIES = 5;

/** one game's numbers for the mission counters */
export type MissionCounts = Partial<Record<MissionCounter, number>>;

/** a mission a game finished, with what it paid */
export interface MissionDone {
  id: string;
  coins: number;
  xp: number;
}

/** small seeded random numbers (mulberry32) */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** n different items, picked at random */
function pickSome<T>(items: readonly T[], n: number, rand: () => number): T[] {
  const pool = [...items];
  const out: T[] = [];
  while (out.length < n && pool.length > 0) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

/** an account's set for one IST day or week: one social mission plus others, the same every time for that day or week */
export function dealMissions(userId: string, period: MissionPeriod, key: string): MissionDoc[] {
  const rand = seededRandom(createHash('sha256').update(`${userId}:${period}:${key}`).digest().readUInt32LE(0));
  const pool = MISSIONS.filter((m) => m.period === period);
  const social = pickSome(pool.filter((m) => m.social), 1, rand);
  const others = pickSome(pool.filter((m) => !m.social), MISSIONS_PER_SET - social.length, rand);
  return [...others, ...social].map((m) => ({ id: m.id, progress: 0, done: false }));
}

/** a stored day or week that's missing or before the current one */
const isOld = (stored: string | undefined, current: string) => !stored || stored < current;

/** the stored missions with a set from an earlier IST day or week dealt afresh; the same object when nothing changed */
export function freshMissions(stored: MissionsDoc | undefined, userId: string, now = new Date()): MissionsDoc {
  const day = istDay(now);
  const week = istWeek(now);
  let m: MissionsDoc = stored ?? { rev: 0, day: '', daily: [], week: '', weekly: [] };
  if (isOld(m.day, day)) m = { ...m, day, daily: dealMissions(userId, 'daily', day) };
  if (isOld(m.week, week)) m = { ...m, week, weekly: dealMissions(userId, 'weekly', week) };
  return m;
}

const viewOf = (set: MissionDoc[]): MissionView[] => set.map(({ id, progress, done }) => ({ id, progress, done }));

/** what the app gets: both sets, the swap, and when each set starts again */
function responseOf(m: MissionsDoc, now: Date): MissionsResponse {
  return {
    daily: viewOf(m.daily),
    weekly: viewOf(m.weekly),
    rerollLeft: isOld(m.swapDay, istDay(now)),
    dailyResetAt: nextIstDay(now).toISOString(),
    weeklyResetAt: nextIstWeek(now).toISOString(),
  };
}

/** what one change to an account's missions saves, pays and gives back */
interface Change<T> {
  /** the missions it was given, unchanged, when there's nothing to save */
  missions: MissionsDoc;
  /** paid in the same write */
  coins?: number;
  xp?: number;
  result: T;
}

/** daily and weekly missions: dealt per account, counted from games, paid the moment they're done; one free swap a day */
export class MissionService {
  constructor(private readonly cols: Collections) {}

  /** today's and this week's missions; a new day or week deals a fresh set */
  async get(userId: ObjectId, now = new Date()): Promise<MissionsResponse> {
    const out = await this.change(userId, now, (m) => ({ missions: m, result: null }));
    if (!out) throw new ApiError(404, 'User not found');
    return responseOf(out.missions, now);
  }

  /** adds one game's numbers; a mission that reaches its goal is done and pays its coins and XP in the same write */
  async count(userId: ObjectId, counts: MissionCounts, now = new Date()): Promise<MissionDone[]> {
    const out = await this.change(userId, now, (m) => {
      const done: MissionDone[] = [];
      let moved = false;
      const bump = (x: MissionDoc): MissionDoc => {
        const def = missionOf(x.id);
        const n = def ? (counts[def.counter] ?? 0) : 0;
        if (!def || x.done || !(n > 0)) return x;
        moved = true;
        const progress = Math.min(def.goal, x.progress + n);
        if (progress < def.goal) return { ...x, progress };
        done.push({ id: def.id, coins: def.coins, xp: def.xp });
        return { ...x, progress, done: true };
      };
      const next: MissionsDoc = { ...m, daily: m.daily.map(bump), weekly: m.weekly.map(bump) };
      return {
        missions: moved ? next : m,
        coins: done.reduce((sum, d) => sum + d.coins, 0),
        xp: done.reduce((sum, d) => sum + d.xp, 0),
        result: done,
      };
    });
    return out?.result ?? [];
  }

  /** today's free swap: an unfinished mission for another of the same period not in that set, starting at 0; never a social one, so it's a way out of playing with friends */
  async swap(userId: ObjectId, id: string, now = new Date()): Promise<MissionsResponse> {
    const today = istDay(now);
    const out = await this.change(userId, now, (m) => {
      if (!isOld(m.swapDay, today)) throw new ApiError(400, 'You already swapped a mission today');
      const period: MissionPeriod | null = m.daily.some((x) => x.id === id) ? 'daily' : m.weekly.some((x) => x.id === id) ? 'weekly' : null;
      if (!period) throw new ApiError(400, "That isn't one of your missions");
      const set = period === 'daily' ? m.daily : m.weekly;
      if (set.find((x) => x.id === id)!.done) throw new ApiError(400, 'That mission is done');
      const choices = MISSIONS.filter((d) => d.period === period && !d.social && !set.some((x) => x.id === d.id));
      if (choices.length === 0) throw new ApiError(400, 'There are no other missions to swap in');
      const pick = choices[Math.floor(Math.random() * choices.length)];
      const swapped = set.map((x) => (x.id === id ? { id: pick.id, progress: 0, done: false } : x));
      const missions: MissionsDoc = period === 'daily' ? { ...m, daily: swapped, swapDay: today } : { ...m, weekly: swapped, swapDay: today };
      return { missions, result: null };
    });
    if (!out) throw new ApiError(404, 'User not found');
    return responseOf(out.missions, now);
  }

  /** reads, refreshes and changes an account's missions, then saves them guarded by rev, trying again when another write got in first; null: no such account */
  private async change<T>(userId: ObjectId, now: Date, step: (m: MissionsDoc) => Change<T>): Promise<{ missions: MissionsDoc; result: T } | null> {
    for (let i = 0; i < MAX_TRIES; i++) {
      const user = await this.cols.users.findOne({ _id: userId }, { projection: { missions: 1 } });
      if (!user) return null;
      const { missions, coins = 0, xp = 0, result } = step(freshMissions(user.missions, userId.toHexString(), now));
      if (missions === user.missions) return { missions, result };
      const rev = user.missions?.rev ?? 0;
      const saved: MissionsDoc = { ...missions, rev: rev + 1 };
      // only when nobody wrote since the read; coins and XP ride in the same update, so they're paid exactly once
      const guard: Filter<UserDoc> = user.missions ? { _id: userId, 'missions.rev': rev } : { _id: userId, missions: { $exists: false } };
      const update: UpdateFilter<UserDoc> = { $set: { missions: saved } };
      if (coins > 0 || xp > 0) update.$inc = { coins, 'stats.bonusXp': xp };
      if ((await this.cols.users.updateOne(guard, update)).matchedCount === 1) return { missions: saved, result };
    }
    throw new ApiError(409, 'Missions are busy right now, try again');
  }
}
