import { Router } from 'express';
import type { PlayerLook } from '../../models.js';
import type { Store } from '../../services/store.js';
import { SHOP_LOOK_KINDS, shopWearOf } from '../../services/shop.js';
import { toPublicUser } from '../../services/users.js';
import {
  DEFAULT_CARD_BACK,
  DEFAULT_TABLE_THEME,
  type LeagueResponse,
  type MissionsResponse,
  type PassClaimResponse,
  type PassResponse,
  type ProfileOverview,
  type PublicUser,
  type RivalsResponse,
  type ShopLookKind,
  type ShopResponse,
} from '../../types.js';
import { asPayload, parseName, parseQueryInt } from '../../validate.js';
import { ApiError } from '../errors.js';
import { ah, currentUser, requireUser } from '../middleware.js';

export function meRoutes(store: Store, onLookChanged: (userId: string, look: PlayerLook) => void): Router {
  const r = Router();
  // rooms the player is in show the new look at once
  const lookChanged = (user: PublicUser) =>
    onLookChanged(user.id, { avatar: user.avatar, back: user.cardBack ?? DEFAULT_CARD_BACK, table: user.tableTheme ?? DEFAULT_TABLE_THEME });
  r.use(requireUser(store));

  // opening the app counts as the day's login, so the daily bonus is paid here too
  r.get(
    '/',
    ah(async (_req, res) => {
      const daily = await store.users.claimLoginBonus(currentUser(res));
      // a new ranked season since last time: last season goes into the history and the rank drops a little
      const user = await store.ranked.rollover(daily.user);
      const friendRequests = await store.friends.incomingCount(user._id);
      res.json({ user: toPublicUser(user), bonus: daily.bonus, friendRequests });
    }),
  );

  // the daily spin wheel: one free spin per IST day
  r.post(
    '/spin',
    ah(async (_req, res) => {
      res.json(await store.spin.spin(currentUser(res)._id));
    }),
  );

  r.get(
    '/overview',
    ah(async (_req, res) => {
      const me = currentUser(res);
      const [overview, friends] = await Promise.all([store.users.overview(me), store.friends.countFor(me._id)]);
      const body: ProfileOverview = { ...overview, friends };
      res.json(body);
    }),
  );

  // this week's friends league board, and last week's
  r.get(
    '/league',
    ah(async (_req, res) => {
      const body: LeagueResponse = await store.league.board(currentUser(res)._id);
      res.json(body);
    }),
  );

  // leave me off my friends' league boards, or put me back
  r.post(
    '/league/hide',
    ah(async (req, res) => {
      const hidden = asPayload(req.body).hidden;
      if (typeof hidden !== 'boolean') throw new ApiError(400, 'Say whether to hide you');
      const me = currentUser(res)._id;
      await store.league.setHidden(me, hidden);
      const body: LeagueResponse = await store.league.board(me);
      res.json(body);
    }),
  );

  // my records against every friend I've finished a game with
  r.get(
    '/rivals',
    ah(async (_req, res) => {
      const body: RivalsResponse = await store.rivals.list(currentUser(res)._id);
      res.json(body);
    }),
  );

  // today's and this week's missions; a new day or week deals a fresh set
  r.get(
    '/missions',
    ah(async (_req, res) => {
      const body: MissionsResponse = await store.missions.get(currentUser(res)._id);
      res.json(body);
    }),
  );

  // today's one free swap of an unfinished daily or weekly mission
  r.post(
    '/missions/swap',
    ah(async (req, res) => {
      const id = asPayload(req.body).id;
      if (typeof id !== 'string' || id.length > 40) throw new ApiError(400, "That isn't one of your missions");
      const body: MissionsResponse = await store.missions.swap(currentUser(res)._id, id);
      res.json(body);
    }),
  );

  // the season pass for the ranked season now on: XP, tiers reached and claimed
  r.get(
    '/pass',
    ah(async (_req, res) => {
      const body: PassResponse = await store.pass.get(currentUser(res)._id);
      res.json(body);
    }),
  );

  // claim one reached tier's reward (never automatic); a tier pays once
  r.post(
    '/pass/claim',
    ah(async (req, res) => {
      const tier = asPayload(req.body).tier;
      if (typeof tier !== 'number' || !Number.isInteger(tier)) throw new ApiError(400, 'That tier is not on the pass');
      const body: PassClaimResponse = await store.pass.claim(currentUser(res)._id, tier);
      res.json(body);
    }),
  );

  // the player's own display name: the first change any time, then once every NAME_CHANGE_DAYS
  r.post(
    '/name',
    ah(async (req, res) => {
      const name = parseName(asPayload(req.body).displayName);
      res.json({ user: await store.users.changeOwnName(currentUser(res)._id, name) });
    }),
  );

  // a face on a background ("fox.sunset"), or null for the first letter; locked ones need the level first
  r.post(
    '/avatar',
    ah(async (req, res) => {
      const avatar = asPayload(req.body).avatar;
      if (avatar !== null && (typeof avatar !== 'string' || avatar.length > 40)) throw new ApiError(400, 'Pick one of the avatars');
      const user = await store.users.setAvatar(currentUser(res)._id, avatar);
      lookChanged(user);
      res.json({ user });
    }),
  );

  // the card back everyone sees on this player's cards, or null for the classic one; locked ones need the level first
  r.post(
    '/back',
    ah(async (req, res) => {
      const back = asPayload(req.body).back;
      if (back !== null && (typeof back !== 'string' || back.length > 20)) throw new ApiError(400, 'Pick one of the card backs');
      const user = await store.users.setCardBack(currentUser(res)._id, back);
      lookChanged(user);
      res.json({ user });
    }),
  );

  // the table theme: their felt, and the seat box everyone sees round their name; null for classic green
  r.post(
    '/table',
    ah(async (req, res) => {
      const table = asPayload(req.body).table;
      if (table !== null && (typeof table !== 'string' || table.length > 20)) throw new ApiError(400, 'Pick one of the tables');
      const user = await store.users.setTableTheme(currentUser(res)._id, table);
      lookChanged(user);
      res.json({ user });
    }),
  );

  // the coin shop: what's running and what's worn
  r.get(
    '/shop',
    ah(async (_req, res) => {
      const body: ShopResponse = await store.shop.get(currentUser(res)._id);
      res.json(body);
    }),
  );

  // rent an item for its day or week (again: adds the time); a look is worn at once and shows in their room
  r.post(
    '/shop/buy',
    ah(async (req, res) => {
      const id = asPayload(req.body).id;
      if (typeof id !== 'string' || id.length > 40) throw new ApiError(400, 'That item is not in the shop');
      const { shop, user } = await store.shop.buy(currentUser(res)._id, id);
      const pub = toPublicUser(user);
      onLookChanged(pub.id, { avatar: pub.avatar, back: pub.cardBack ?? DEFAULT_CARD_BACK, table: pub.tableTheme ?? DEFAULT_TABLE_THEME, shop: shopWearOf(user) });
      res.json({ shop, user: pub });
    }),
  );

  // show another of their running looks of a kind, or none (id null)
  r.post(
    '/shop/wear',
    ah(async (req, res) => {
      const { kind, id } = asPayload(req.body);
      if (typeof kind !== 'string' || !(SHOP_LOOK_KINDS as readonly string[]).includes(kind)) throw new ApiError(400, 'Pick aura, win or entry');
      if (id !== null && (typeof id !== 'string' || id.length > 40)) throw new ApiError(400, 'Pick one of your shop items');
      const { shop, user } = await store.shop.wear(currentUser(res)._id, kind as ShopLookKind, id);
      const pub = toPublicUser(user);
      onLookChanged(pub.id, { avatar: pub.avatar, back: pub.cardBack ?? DEFAULT_CARD_BACK, table: pub.tableTheme ?? DEFAULT_TABLE_THEME, shop: shopWearOf(user) });
      res.json({ shop, user: pub });
    }),
  );

  // the practice tutorial for a game was finished or skipped: it isn't offered again on any phone
  r.post(
    '/tutorial',
    ah(async (req, res) => {
      const game = asPayload(req.body).game;
      if (game !== 'bluff' && game !== 'crazy7') throw new ApiError(400, 'Unknown game');
      res.json({ user: await store.users.markTutorial(currentUser(res)._id, game) });
    }),
  );

  r.get(
    '/games',
    ah(async (req, res) => {
      const limit = parseQueryInt(req.query.limit, 20, 50) || 20;
      res.json({ games: await store.games.recentFor(currentUser(res)._id, limit) });
    }),
  );

  // a game I played, move by move; 404 for others' games and older games without a replay
  r.get(
    '/games/:id/replay',
    ah(async (req, res) => {
      const me = currentUser(res);
      const replay = await store.games.replayFor(String(req.params.id), me._id, me.role === 'admin');
      if (!replay) throw new ApiError(404, 'No replay for this game');
      res.json(replay);
    }),
  );

  return r;
}
