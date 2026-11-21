import { randomInt } from 'node:crypto';
import type { ObjectId } from 'mongodb';
import type { Collections } from '../db/documents.js';
import { istDay } from '../days.js';
import { ApiError } from '../http/errors.js';
import { SPIN_PRIZES, type SpinResponse } from '../types.js';
import { toPublicUser } from './users.js';

/** chance of each SPIN_PRIZES slice, out of 100 (server only): the bigger the prize, the rarer */
export const SPIN_WEIGHTS = [28, 16, 20, 12, 10, 8, 5, 1] as const;

/** a slice of the wheel; pick is 0-99 (tests pass their own) */
export function spinSlice(pick = randomInt(100)): number {
  let left = pick;
  for (let i = 0; i < SPIN_WEIGHTS.length; i++) {
    if (left < SPIN_WEIGHTS[i]) return i;
    left -= SPIN_WEIGHTS[i];
  }
  return 0;
}

/** one free spin of the daily wheel per IST day: coins or bonus XP */
export class SpinService {
  constructor(private readonly cols: Collections) {}

  async spin(userId: ObjectId, pick?: number): Promise<SpinResponse> {
    const today = istDay();
    const index = spinSlice(pick);
    const prize = SPIN_PRIZES[index];
    const inc = prize.kind === 'coins' ? { coins: prize.amount } : { 'stats.bonusXp': prize.amount };
    // the day check is in the update itself, so two taps can't spin twice
    const user = await this.cols.users.findOneAndUpdate(
      { _id: userId, lastSpinDay: { $ne: today } },
      { $inc: inc, $set: { lastSpinDay: today } },
      { returnDocument: 'after' },
    );
    if (!user) throw new ApiError(409, 'You already spun today. Come back tomorrow');
    return { index, prize: { ...prize }, user: toPublicUser(user) };
  }
}
