import { type ObjectId, type Filter, type UpdateFilter, type WithId } from 'mongodb';
import type { Collections, PassDoc, UserDoc } from '../db/documents.js';
import { ApiError } from '../http/errors.js';
import { MAX_SHIELDS, PASS_SHIELD_COINS, PASS_TIER_XP, PASS_TIERS, passTierOf, type PassClaimResponse, type PassResponse, type PassReward } from '../types.js';
import { rankedSeasonDates, type SettingsService } from './settings.js';
import { toPublicUser } from './users.js';

/** the stored pass when it's this season's; a pass from another season (or none) counts as a fresh one */
export const passIn = (doc: PassDoc | undefined, season: number): PassDoc =>
  doc && doc.season === season ? doc : { season, xp: 0, claimed: [] };

/** what the app gets: the season's dates, XP, and every tier with reached and claimed */
export function passViewOf(doc: PassDoc | undefined, season: number): PassResponse {
  const p = passIn(doc, season);
  const tier = passTierOf(p.xp);
  const dates = rankedSeasonDates();
  const tiers = PASS_TIERS.map((reward, i) => ({ tier: i + 1, reward: { ...reward }, reached: i + 1 <= tier, claimed: p.claimed.includes(i + 1) }));
  return {
    season,
    startedAt: dates.startedAt?.toISOString() ?? null,
    endsAt: dates.nextAt?.toISOString() ?? null,
    xp: Math.min(p.xp, PASS_TIERS.length * PASS_TIER_XP),
    tier,
    tiers,
    claimable: tiers.filter((t) => t.reached && !t.claimed).length,
  };
}

/** the free season pass: XP from games that count, tiers claimed by tapping, started again by each new ranked season */
export class SeasonPassService {
  constructor(
    private readonly cols: Collections,
    private readonly settings: SettingsService,
  ) {}

  async get(userId: ObjectId): Promise<PassResponse> {
    const user = await this.cols.users.findOne({ _id: userId }, { projection: { pass: 1 } });
    if (!user) throw new ApiError(404, 'User not found');
    return passViewOf(user.pass, this.settings.rankedSeason);
  }

  /** adds pass XP in one atomic write; a pass from another season starts again from this XP */
  async addXp(userId: ObjectId, xp: number): Promise<void> {
    if (!(xp > 0)) return;
    const season = this.settings.rankedSeason;
    const same = { $eq: [{ $ifNull: ['$pass.season', null] }, season] };
    await this.cols.users.updateOne({ _id: userId }, [
      {
        $set: {
          pass: {
            $cond: [same, { season, xp: { $add: [{ $ifNull: ['$pass.xp', 0] }, xp] }, claimed: { $ifNull: ['$pass.claimed', []] } }, { season, xp, claimed: [] }],
          },
        },
      },
    ]);
  }

  /** pays one reached, unclaimed tier; the checks are in the write itself, so two taps can't claim it twice */
  async claim(userId: ObjectId, tier: number): Promise<PassClaimResponse> {
    const reward = Number.isInteger(tier) ? PASS_TIERS[tier - 1] : undefined;
    if (!reward) throw new ApiError(400, 'That tier is not on the pass');
    const season = this.settings.rankedSeason;
    const base: Filter<UserDoc> = { _id: userId, 'pass.season': season, 'pass.xp': { $gte: tier * PASS_TIER_XP }, 'pass.claimed': { $ne: tier } };
    const write = (filter: Filter<UserDoc>, inc: Record<string, number>) =>
      this.cols.users.findOneAndUpdate(filter, { $push: { 'pass.claimed': tier }, $inc: inc } as UpdateFilter<UserDoc>, { returnDocument: 'after' });

    let got: PassReward = { ...reward };
    let shieldSwapped = false;
    let saved: WithId<UserDoc> | null;
    if (reward.kind === 'shield') {
      // a shield only while they hold fewer than MAX_SHIELDS; rev goes up so a shop buy read before this retries
      saved = await write(
        { ...base, $or: [{ 'shop.shields': { $lt: MAX_SHIELDS } }, { 'shop.shields': { $exists: false } }] },
        { 'shop.shields': 1, 'shop.rev': 1 },
      );
      if (!saved) {
        saved = await write(base, { coins: PASS_SHIELD_COINS });
        if (saved) {
          got = { kind: 'coins', amount: PASS_SHIELD_COINS };
          shieldSwapped = true;
        }
      }
    } else {
      saved = await write(base, reward.kind === 'coins' ? { coins: reward.amount } : { 'stats.bonusXp': reward.amount });
    }
    if (!saved) throw await this.whyNot(userId, tier, season);

    return { pass: passViewOf(saved.pass, season), got, shieldSwapped, user: toPublicUser(saved) };
  }

  /** the reason a claim didn't go through */
  private async whyNot(userId: ObjectId, tier: number, season: number): Promise<ApiError> {
    const user = await this.cols.users.findOne({ _id: userId }, { projection: { pass: 1 } });
    if (!user) return new ApiError(404, 'User not found');
    const p = passIn(user.pass, season);
    if (p.claimed.includes(tier)) return new ApiError(409, 'You already claimed that tier');
    if (passTierOf(p.xp) < tier) return new ApiError(400, `Reach tier ${tier} first`);
    return new ApiError(409, 'The pass is busy right now, try again');
  }
}
