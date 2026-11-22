import { MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyHabits, HABIT_TURN_LIMIT, habitsPipeline, mergeHabits } from '../src/habits.js';
import type { Habits } from '../src/models.js';

/** one game's habits: plays following a round, this many of them lies */
const gameOf = (plays: number, lies: number): Habits => ({ ...emptyHabits(), followPlays: plays, followLies: lies, lies, lieCards: lies });
const rate = (h: Habits) => h.followLies / h.followPlays;

describe('habits weigh recent games more', () => {
  it('a new game counts about 1 in 25 against the old totals, not 1 in a lifetime', () => {
    let h: Habits | null = null;
    // 500 games of mostly honest play
    for (let i = 0; i < 500; i++) h = mergeHabits(h, gameOf(20, 2));
    expect(rate(h!)).toBeCloseTo(0.1, 2);
    // then they start lying a lot (0.6): 15 games move the read about halfway; lifetime totals would still say 0.115
    for (let i = 0; i < 15; i++) h = mergeHabits(h, gameOf(20, 12));
    expect(rate(h!)).toBeGreaterThan(0.32);
    // the newest game alone is about 1 part in 25
    const before = rate(h!);
    const one = rate(mergeHabits(h, gameOf(20, 20)));
    expect((one - before) / (1 - before)).toBeCloseTo(0.04, 2);
    // after 40 games the new style leads
    for (let i = 0; i < 25; i++) h = mergeHabits(h, gameOf(20, 12));
    expect(rate(h!)).toBeGreaterThan(0.49);
  });

  it('scales a huge old history down to the turn limit, keeping its ratios', () => {
    const old = { ...emptyHabits(), followPlays: 200_000, followLies: 50_000, pushes: 10_000, passNone: 30_000 };
    const h = mergeHabits(old, emptyHabits());
    expect(h.followPlays + h.pushes + h.passNone).toBeCloseTo(HABIT_TURN_LIMIT, 0);
    expect(h.followLies / h.followPlays).toBeCloseTo(0.25, 3);
    expect(h.pushes / (h.pushes + h.passNone)).toBeCloseTo(0.25, 3);
  });
});

// run with TEST_MONGODB_URI=mongodb://127.0.0.1:27099 (a throwaway database is created and dropped)
const MONGO = process.env.TEST_MONGODB_URI;

describe.skipIf(!MONGO)('habits update in MongoDB', () => {
  let client: MongoClient;
  const name = `bluff_habits_test_${Date.now()}`;
  beforeAll(async () => {
    client = await MongoClient.connect(MONGO!);
  });
  afterAll(async () => {
    await client.db(name).dropDatabase();
    await client.close();
  });

  it('gives the same totals as mergeHabits, from nothing and from a long history', async () => {
    const users = client.db(name).collection<{ _id: ObjectId; habits?: Partial<Habits> }>('users');
    const fresh = new ObjectId();
    const veteran = new ObjectId();
    const old = { ...emptyHabits(), followPlays: 90_000, followLies: 9_000, openPlays: 30_000, openLies: 6_000, botSeen: 400, botCalls: 100 };
    await users.insertMany([{ _id: fresh }, { _id: veteran, habits: old }]);
    const game = { ...gameOf(14, 5), openPlays: 4, openLies: 1, botSeen: 3, botCalls: 2 };
    for (const id of [fresh, veteran]) await users.updateOne({ _id: id }, habitsPipeline(game));
    const [a, b] = await Promise.all([users.findOne({ _id: fresh }), users.findOne({ _id: veteran })]);
    expect(a!.habits).toEqual(mergeHabits(null, game));
    expect(b!.habits).toEqual(mergeHabits(old, game));
  });
});
