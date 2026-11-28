# bluff-backend — guide for Claude

Game server for **Bluff**, a free real-time card game for a group of friends (mostly on phones).
Deployed on Render (https://bluff-backend-a697.onrender.com, auto-deploys `main`). The app is the sibling repo
`bluff-frontend` (Vercel). If both repos sit side by side, the parent folder's `CLAUDE.md` has the whole-project
guide, the feature list and the owner's working preferences. Read it first.

## Stack

Node 22, TypeScript (ESM, NodeNext), Socket.IO 4.8 + Express 4 on one http server, MongoDB driver 6 (no mongoose),
vitest 5 (vite 8 as dev peer) + supertest. Accounts are optional: without `MONGODB_URI` the server runs guest-only.

## Map

| File | Role |
|---|---|
| `src/types.ts` | Shapes and constants shared with the app. **The frontend copy must stay identical** (only the "Keep in sync" header differs). Shared logic too: `levelOf`, `xpOf`, `XP_RULES`, `DAILY_GAME_REWARDS`, `BET_STEPS`, `MAX_PEEKS` |
| `src/game.ts` | Pure game rules (deal, play, pass, bluff, peek, bets, 2v2 teams, finishing, winners/losers). No sockets |
| `src/crazy7/` | Second game, Crazy 7: `game.ts` (pure rules; `fromState` copies for bot search), bots (`driver.ts` timers, `brain.ts` search, `memory.ts` public events). The room holds `game` (Bluff) or `c7`; `room.table` is whichever is on (`TableGame` in `models.ts`) |
| `src/games/` | **Game registry** (Game Baithak): every game after Rang plugs in here. `module.ts` (`GameModule`: create, view, move, describe, auto, clock, botMove, turnKey, inPlay, tallies, missionCounts), `registry.ts` (`MODULES`, `moduleOf`, `maybeModule`), `driver.ts` (`PluggedDriver`: automatic steps, bots at a human pace, game time, the turn timer's stand-in, for every registry game). The room holds it in `room.plugged` (part of `room.table`), the view in `RoomView.plugged`, moves arrive as `game:move` |
| `src/games/snakes/`, `src/games/rmcs/` | Saanp Seedhi (`game.ts` rules: the token moves on the roll, `module.ts`: bots roll through `auto()` once the last move has shown) and Raja Mantri Chor Sipahi (`game.ts` rules: open → guess → result rounds, per-seat `view` with only my own chit; `module.ts`: every timed step, bot opens and the bot Mantri's 50/50 guess through `auto()`). Each has its own chat set (`chatSetOf`) |
| `src/games/darts/`, `src/games/dots/`, `src/games/colorwar/` | Darts (`game.ts`: 3 darts a turn, the server's shake, bust/checkout, a 1.6 s pause before the turn moves on through `auto()`; `brain.ts`: aim + level noise; bots throw via `auto()`), Dots and Boxes (`game.ts`, `brain.ts`: take, stay safe, Expert counts chains; bots via the driver) and Colour Wars (`board.ts` burst chain, `game.ts`, `brain.ts` tap scoring; bots via `auto()` after the chain has shown). Each has its own chat set |
| `src/games/fruit/`, `src/games/spikes/` | Real-time games (everyone at once, `turnId` null): Fruit Slice Duel (`game.ts`: a reaction duel, one item at a time, strikes judged by the phone's reaction with server-clock checks, magnets slow your sword; bots' strikes planned when each item shows) and Spike Attack (`arena.ts`: seeded fair box layout, wall reach hits, circle-vs-box collision and grid paths; `game.ts`: free movement clamped to `SPIKES_SPEED` and slid round boxes, whole-side walls, lives, places; `brain.ts`: bots path round boxes to squares the noticed walls can't reach). `GameModule.live` (Spikes) coalesces position moves into one view push per 80 ms (`pushSoon` in `socket.ts`). Countdown, timed steps and bots all go through `auto()` keyed on `stepSeq` (people's moves don't bump it); `AutoStep.quiet` skips views for steps that changed nothing; `GameModule.moveRate` raises the `game:move` socket limit for that game only |
| `src/games/ludo/` | Ludo: `game.ts` (pure rules, `LudoGame implements TableGame` with no cards), `brain.ts` (Normal / Hard / Expert move scoring), `module.ts` (move parsing, announcer lines, auto steps, tallies) |
| `src/bots/` | Bluff bot engine: `personality.ts` (6 styles, names), `levels.ts` (`config.botLevel` Normal / Hard / Expert), `memory.ts` (public events a bot saw, discards, its own read checks), `profile.ts` (a player's tendencies from saved habits, priors and read checks), `detector.ts` (chance of 0..n fakes in the last play and at each card, from card counting and the profile; hard and expert weigh every way the round's earlier claims could have gone), `brain.ts` (pure decisions from `room.view(botId)`: calls mixed near the line, peeks, its own plays scored and picked at random, and `planOf`: a mode that changes every few rounds), `driver.ts` (timers incl. the 2 s call window; moves go through `Game` and `afterMove` like a person's) |
| `src/habits.ts` | `Habits` counters recorded in `Game.play` / `pass` / `callBluff` with the true cards (incl. how people play around bots: traps, over-claims, calls on bots' plays counted once each person had their chance; `Game.bots` says which seats are bots), merged into `users.habits` by `GameRecorder.save` (`habitsPipeline`: old totals fade by `HABIT_DECAY` per game, capped at `HABIT_TURN_LIMIT` turns, so the last ~25 games weigh most) |
| `src/secrets.ts` | Secret mission cards: deal one per person at the start (`dealSecrets`) and count each card's progress from its holder's own stats and plays (`secretView`) |
| `src/rating.ts` | Ranked skill rating: the Plackett-Luce model (Weng and Lin 2011) for one game's finishing order, no library |
| `src/rooms.ts` | Room and RoomManager: members, host, settings, watch mode, 2v2 slots and swaps, per-member `view()`, announcements, game snapshot |
| `src/socket.ts` | Thin event handlers (`room:*`, `game:*`, `chat:send`, `friend:invite`), rate limit, coin checks at start, saving finished games |
| `src/validate.ts` | Every incoming payload is parsed here; throw `GameError` with a message safe to show players |
| `src/models.ts` | Server-only shapes (Member, GameRecord, hooks) |
| `src/services/` | `UserService` (accounts, sessions, coins, admin, audit), `ShopService` (coin shop rentals, boosts, worn looks), `GameRecorder` (save game, stakes, bets, daily ladder, stats), `FriendService`, `MissionService` (daily and weekly missions: deal, count, swap, paid in one guarded write), `LeagueService` (weekly friends league), `RivalService` (records between friends) and `RankedService` (rank points, seasons) |
| `src/http/` | Express app, middleware, routes: `auth`, `me`, `friends`, `players`, `admin` |
| `test/` | `snakes.test.ts`, `rmcs.test.ts` (rules, RMCS secrecy), `party-bots.test.ts`, `party-room.test.ts`, `party-socket.test.ts`; `darts.test.ts`, `dots.test.ts`, `colorwar.test.ts` (rules and bot sims), `g3-room.test.ts`, `g3-socket.test.ts`; `fruit.test.ts`, `spikes.test.ts` (rules, reaction checks, collect window, magnets, speed clamp, wall reach and shields, box collision and layouts, bot sims), `fruit-socket.test.ts`, `spikes-socket.test.ts`, `arcade-stats.test.ts` (needs MongoDB); `game.test.ts` (rules), `bots.test.ts` (engine plays hundreds of games), `socket.test.ts` and `bots-socket.test.ts` (no DB), `api.test.ts` (needs MongoDB); `missions.test.ts` (needs MongoDB) and `secrets.test.ts` for missions and secret cards |

The socket events and HTTP routes are listed in `README.md`. Keep those tables updated.

## Commands

Local MongoDB for dev and tests: a **throwaway instance on port 27099**. Never use 27017; that's the owner's work database.

```bash
npm run dev
```
(with `MONGODB_URI=mongodb://127.0.0.1:27099 MONGODB_DB=bluff_ui ADMIN_API_KEY=<local secret>` for accounts)

```bash
npx tsc --noEmit -p . && TEST_MONGODB_URI=mongodb://127.0.0.1:27099 npx vitest run
```

Env: `MONGODB_URI` (only one required for accounts), `CLIENT_ORIGIN` (allowed app origin(s), comma separated;
unset = localhost/LAN only), optional `MONGODB_DB`, `ADMIN_API_KEY`, `DEFAULT_COINS` (1000), `SESSION_TTL_DAYS` (30), `PORT`,
and for friend-invite notifications `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` (secret) + optional `VAPID_SUBJECT` (`services/push.ts`;
without the keys push is off; an admin can also switch it off in the app).

## Adding a new game (registry checklist)

1. `src/types.ts` (then copy to both apps, keeping their line 1): add the kind to `GameKind` and `PLUGGED_GAMES`, a `GAME_CATALOG` entry (players, teams, bots, `options`), its view in `PluggedView`, its move in `PluggedMove`, any tallies and mission counters.
2. `src/games/<kind>/`: `game.ts` (pure rules implementing `TableGame`: empty hands, `pile` [], `winners()`/`losers()` like Ludo's, `leave` = forfeit, `removePlayer`, `close`), `brain.ts` (bots by `config.botLevel`), `module.ts` (the `GameModule`).
3. One line in `src/games/registry.ts` (`parseConfig` accepts every `PLUGGED_GAMES` kind; `assertCanStart` checks the catalog's `minPlayers`). Games where everyone moves at once leave `turnId` null and time every step through `auto()`; an `opening` array on the game is read out at the start. Nothing else in rooms or sockets should need a branch.
4. Tests: `test/<kind>.test.ts` (rules), `<kind>-bots.test.ts` (bots finish hundreds of games, levels ordered), `<kind>-room.test.ts` (views, seats, app check), `<kind>-socket.test.ts` (a game over `game:move`).
5. README (rules, `game:move` payload) and this map.

## Rules of thumb

- Coins are virtual. Stakes, bets and the daily ladder settle only in `GameRecorder.save` for **finished** games; stopped games move nothing; balances never go below zero.
- Bots: never a room of only bots (`hasPeople`, `afterExit`, `endIfOnlyBots`, which waits while a person's last cards can still be called: `Game.goingOut`); bots always call a player's last cards; stake capped by bot level (`botStakeCap`: Normal free only, Hard 100, Expert and Crazy 7 1,000; `Room.capStake` lowers it when a bot joins or the level drops); bots pay nothing, a person who wins takes every seat's stake, coins lost to a bot are gone. Bots decide only from `room.view(botId)`, public events and each person's saved habits from past games (`Member.habits`, read with the account at join and before each Bluff deal with bots), never another hand or the cards of the current play (a test checks a decision doesn't change when only those change), and never touch the database during a game. Habits are server-only: never put them in `PublicUser`, profiles or `RoomView`.
- People get at least 2 s to call a play before a bot's own move (`CALL_WINDOW` in `bots/driver.ts`). When tuning the engine, check behaviour with a simulation (person win %, lie %, call % by claim size, call accuracy, peek hits, levels against each other, and simulated people who play around bots: never call them, call everything, fake first and play real later), not by eye; keep `test/bots-detector.test.ts` and `test/bots-tricks.test.ts` passing. Bots must stay hard to read: lie often at every level and change plans, so a claim never gives their hand away (a pass still mostly means none). Learning from what's turned over must never make a trapper look more honest (see `noteTrap`).
- `friend:online` goes to online friends when an account comes back after 15+ seconds away, never to friends in the same room and never in the first 2 minutes after a server start (`OnlineAlertTimes` in `socket.ts`).
- League, rivals and ranked never count bots, guests or players the host removed. Ranked tables take logged-in people only (no bots, Bluff only); rank points move only in `RankedService.rate`, with no daily limit and never below 0 (nothing owed), scaled by the division shown (`RANK_RATES` in `services/ranked.ts`, server-only: never move it into `types.ts` or show it in the app); the division shown (`ranked.floor`) holds until points are `RANK_PROTECTION` (50) below its start; a held Rank Shield (`users.shop.shields`) cancels one loss. Everyone starts at Bronze 0. A new season is booked 7 days ahead and started by the timer in `server.ts`; a standing moves into it 1.5 divisions lower (`standingIn`) on `GET /api/me` or the next ranked game, guarded on `ranked.season` + `ranked.games`, with the old season pushed to `users.rankHistory`.
- Missions: coins and `stats.bonusXp` are paid in the same guarded update that marks a mission done (`rev`), so nothing pays twice; only games that count for the daily ladder move them. Secret mission cards are dealt to people only, and a player's view carries only their own card until game over (test it when touching `view()`).
- Coin shop (`services/shop.ts`): every item is a rental (1 or 7 days), never owned. Boosts are read once in `GameRecorder.save` and touch only games that count; XP boosts multiply only the game's own XP. Looks reach rooms through `lookChanged` (with `shop`) and show only while the rental runs (`shopLookOf`). Buys are `rev`-guarded and audited.
- Saza badges (`Member.saza`) live in the room only: set in `Room.settleSaza` at a Bluff game's end, swapped by the winner with `room:saza`, never saved.
- New room settings default to **off** and must accept older apps that don't send them (see `parseConfig`). `config.game` picks Bluff or Crazy 7; Crazy 7 ignores Bluff's extras (kept for switching back).
- Code that works for both games goes through `room.table`; Bluff-only code uses `room.game`, Crazy 7 `room.c7`, registry games `room.plugged` with `moduleOf(kind)`. Use `room.inPlay(id)` (not `hand().length`) to ask whether someone is still in the game. Seats follow `room.seatLimit` (`GAME_CATALOG` maxPlayers, at most `MAX_PLAYERS`).
- Seated players never get another player's cards (except 2v2 partners via `partnerHand` in Bluff and `RangView.partner` in Rang, and past plays once the game is over: `Game.lieRecap`, `room:plays`). Add a test when touching `view()`.
- Watchers see every hand, so once a game is playing `room:join` becomes a watch request (`requestWatch`) the host approves with `room:admit`; `room:lobby` lets everyone still waiting in.
- `room:leave` mid-game with cards, or with last cards not yet settled, is a forfeit (`game.leave`): the player is in `losers()` and still pays the stake. A kick (`removePlayer`) pays nothing.
- Limits: one room per account (`releaseOthers` in `socket.ts`), per-IP sockets/rooms (`RoomLimits`, `MAX_CONNECTIONS_PER_IP`), per-account 20/min on search, profiles and friend actions (`userRateLimit`). Tests use roomy limits; the limits test runs its own server.
- Admin changes go through `UserService` and are written to the audit log.
- Announcements: `room.note(kind, text)`; kind `room` is shown but not spoken.
- Match the existing style; short one-line comments; add vitest tests for new rules.
- Commit or push only when the owner asks. Commit with the repo's configured identity and end messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Push this repo before the frontend:
  ```bash
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c credential.helper='!gh auth git-credential' push origin main
  ```
- Never put real connection strings, keys or passwords in code, logs or chat. Never create test accounts on production.
