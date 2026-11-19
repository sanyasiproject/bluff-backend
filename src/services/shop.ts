import { ObjectId, type Filter, type UpdateFilter, type WithId } from 'mongodb';
import type { Collections, ShopDoc, UserDoc } from '../db/documents.js';
import type { ShopWear } from '../models.js';
import { MAX_SHIELDS, SHOP_ITEMS, shopItemOf, type ShopItem, type ShopLook, type ShopLookKind, type ShopResponse } from '../types.js';
import { ApiError } from '../http/errors.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRIES = 4;
/** never rent further ahead than this, so a run of buys can't park coins for months */
const MAX_AHEAD_DAYS = 28;
export const SHOP_LOOK_KINDS: readonly ShopLookKind[] = ['aura', 'win', 'entry'];

const isLook = (kind: ShopItem['kind']): kind is ShopLookKind => (SHOP_LOOK_KINDS as readonly string[]).includes(kind);

/** rentals still running at `now`, of items still in the catalogue */
export const activeRentals = (shop: ShopDoc | undefined, now = new Date()) =>
  (shop?.rentals ?? []).filter((r) => r.until.getTime() > now.getTime() && shopItemOf(r.id));

/** what a player shows others: each worn look with the time it runs out, only while its rental runs */
export function shopWearOf(u: Pick<UserDoc, 'shop'>, now = new Date()): ShopWear {
  const active = activeRentals(u.shop, now);
  const one = (kind: ShopLookKind) => {
    const id = u.shop?.wearing?.[kind];
    const r = id ? active.find((x) => x.id === id && shopItemOf(x.id)?.kind === kind) : undefined;
    return r ? { id: r.id, until: r.until.getTime() } : null;
  };
  return { aura: one('aura'), win: one('win'), entry: one('entry') };
}

export const NO_WEAR: ShopWear = { aura: null, win: null, entry: null };

/** the looks to show right now (a rental that ran out mid-room stops showing) */
export function shopLookOf(wear: ShopWear | null | undefined, now = Date.now()): ShopLook {
  const on = (w: { id: string; until: number } | null) => (w && w.until > now ? w.id : null);
  return { aura: on(wear?.aura ?? null), win: on(wear?.win ?? null), entry: on(wear?.entry ?? null) };
}

/** the running multiplier of a boost kind; 1 when none */
export function boostOf(u: Pick<UserDoc, 'shop'> | undefined, kind: 'xp' | 'coins', now = new Date()): number {
  const r = activeRentals(u?.shop, now).find((x) => shopItemOf(x.id)?.kind === kind);
  return shopItemOf(r?.id)?.mult ?? 1;
}

export function shopResponseOf(u: WithId<UserDoc>, now = new Date()): ShopResponse {
  const wear = shopWearOf(u, now);
  return {
    coins: u.coins,
    active: activeRentals(u.shop, now)
      .sort((a, b) => a.until.getTime() - b.until.getTime())
      .map((r) => ({ id: r.id, until: r.until.toISOString() })),
    wearing: { aura: wear.aura?.id ?? null, win: wear.win?.id ?? null, entry: wear.entry?.id ?? null },
    shields: u.shop?.shields ?? 0,
  };
}

/** rents shop items for coins; every item runs out, buying one again adds its time */
export class ShopService {
  constructor(private readonly cols: Collections) {}

  async get(userId: ObjectId, now = new Date()): Promise<ShopResponse> {
    const user = await this.cols.users.findOne({ _id: userId });
    if (!user) throw new ApiError(404, 'User not found');
    return shopResponseOf(user, now);
  }

  /** pays and adds the rental in one guarded write; a look bought is worn at once. One XP boost and one coin boost at a time */
  async buy(userId: ObjectId, itemId: string, now = new Date()): Promise<{ shop: ShopResponse; user: WithId<UserDoc>; item: ShopItem }> {
    const item = shopItemOf(itemId);
    if (!item) throw new ApiError(400, 'That item is not in the shop');
    for (let i = 0; i < MAX_TRIES; i++) {
      const user = await this.cols.users.findOne({ _id: userId });
      if (!user) throw new ApiError(404, 'User not found');
      if (user.coins < item.price) throw new ApiError(400, `You need 🪙 ${item.price - user.coins} more for ${item.name}`);
      const active = activeRentals(user.shop, now);
      const rev = user.shop?.rev ?? 0;
      const shields = user.shop?.shields ?? 0;
      if (item.kind === 'shield' && shields >= MAX_SHIELDS) throw new ApiError(400, `You can hold ${MAX_SHIELDS} Rank Shields. Lose a ranked game to use one`);
      if (item.kind === 'xp' || item.kind === 'coins') {
        const other = active.find((r) => r.id !== item.id && shopItemOf(r.id)?.kind === item.kind);
        if (other) throw new ApiError(400, `${shopItemOf(other.id)!.name} is still running. Buy it again to add time, or wait till it ends`);
      }
      let rentals = active;
      if (item.kind !== 'shield') {
        const current = active.find((r) => r.id === item.id);
        const from = current ? current.until.getTime() : now.getTime();
        const until = new Date(from + item.days * DAY_MS);
        if (until.getTime() - now.getTime() > MAX_AHEAD_DAYS * DAY_MS) throw new ApiError(400, `You can rent ${item.name} up to ${MAX_AHEAD_DAYS} days ahead`);
        rentals = [...active.filter((r) => r.id !== item.id), { id: item.id, until }];
      }
      const shop: ShopDoc = {
        rev: rev + 1,
        rentals,
        wearing: { ...(user.shop?.wearing ?? {}), ...(isLook(item.kind) ? { [item.kind]: item.id } : {}) },
        // a shield is a card you hold, not a rental
        shields: shields + (item.kind === 'shield' ? 1 : 0),
      };
      // only when nobody wrote since the read, and the coins are still there
      const guard: Filter<UserDoc> = { _id: userId, coins: { $gte: item.price }, ...(user.shop ? { 'shop.rev': rev } : { shop: { $exists: false } }) };
      const update: UpdateFilter<UserDoc> = { $inc: { coins: -item.price }, $set: { shop } };
      const saved = await this.cols.users.findOneAndUpdate(guard, update, { returnDocument: 'after' });
      if (!saved) continue;
      await this.cols.audit.insertOne({
        _id: new ObjectId(),
        action: 'shop',
        targetUserId: userId,
        byUserId: userId,
        via: 'player',
        amount: -item.price,
        balanceAfter: saved.coins,
        detail: `Shop: ${item.name}${item.days === 0 ? '' : item.days === 1 ? ' (1 day)' : ' (7 days)'}`,
        createdAt: now,
      });
      return { shop: shopResponseOf(saved, now), user: saved, item };
    }
    throw new ApiError(409, 'The shop is busy right now, try again');
  }

  /** shows one of their running looks of a kind, or none (null) */
  async wear(userId: ObjectId, kind: ShopLookKind, itemId: string | null, now = new Date()): Promise<{ shop: ShopResponse; user: WithId<UserDoc> }> {
    if (itemId !== null) {
      const item = shopItemOf(itemId);
      if (!item || item.kind !== kind) throw new ApiError(400, 'Pick one of your shop items');
      const user = await this.cols.users.findOne({ _id: userId }, { projection: { shop: 1 } });
      if (!user) throw new ApiError(404, 'User not found');
      if (!activeRentals(user.shop, now).some((r) => r.id === itemId)) throw new ApiError(400, `${item.name} isn't running. Rent it in the shop first`);
    }
    // rev goes up so a buy that read before this retries instead of undoing it
    const update: UpdateFilter<UserDoc> =
      itemId === null ? { $unset: { [`shop.wearing.${kind}`]: '' }, $inc: { 'shop.rev': 1 } } : { $set: { [`shop.wearing.${kind}`]: itemId }, $inc: { 'shop.rev': 1 } };
    const saved = await this.cols.users.findOneAndUpdate({ _id: userId }, update, { returnDocument: 'after' });
    if (!saved) throw new ApiError(404, 'User not found');
    return { shop: shopResponseOf(saved, now), user: saved };
  }
}

/** every catalogue id, for validation */
export const SHOP_IDS = new Set(SHOP_ITEMS.map((i) => i.id));
