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
| `src/bots/` | Bluff bot engine: `personality.ts` (6 styles, names), `levels.ts` (`config.botLevel` Normal / Hard / Expert), `memory.ts` (public events a bot saw, discards, its own read checks), `profile.ts` (a player's tendencies from saved habits, priors and read checks), `detector.ts` (chance of 0..n fakes in the last play and at each card, from card counting and the profile), `brain.ts` (pure decisions from `room.view(botId)`: calls, peeks, its own plays), `driver.ts` (timers incl. the 2 s call window; moves go through `Game` and `afterMove` like a person's) |
| `src/habits.ts` | `Habits` counters recorded in `Game.play` / `pass` with the true cards, added to `users.habits` by `GameRecorder.save` |
| `src/rooms.ts` | Room and RoomManager: members, host, settings, watch mode, 2v2 slots and swaps, per-member `view()`, announcements, game snapshot |
| `src/socket.ts` | Thin event handlers (`room:*`, `game:*`, `chat:send`, `friend:invite`), rate limit, coin checks at start, saving finished games |
| `src/validate.ts` | Every incoming payload is parsed here; throw `GameError` with a message safe to show players |
| `src/models.ts` | Server-only shapes (Member, GameRecord, hooks) |
| `src/services/` | `UserService` (accounts, sessions, coins, admin, audit), `GameRecorder` (save game, stakes, bets, daily ladder, stats), `FriendService` |
| `src/http/` | Express app, middleware, routes: `auth`, `me`, `friends`, `players`, `admin` |
| `test/` | `game.test.ts` (rules), `bots.test.ts` (engine plays hundreds of games), `socket.test.ts` and `bots-socket.test.ts` (no DB), `api.test.ts` (needs MongoDB) |

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

## Rules of thumb

- Coins are virtual. Stakes, bets and the daily ladder settle only in `GameRecorder.save` for **finished** games; stopped games move nothing; balances never go below zero.
- Bots: never a room of only bots (`hasPeople`, `afterExit`, `endIfOnlyBots`, which waits while a person's last cards can still be called: `Game.goingOut`); bots always call a player's last cards; stake capped by bot level (`botStakeCap`: Normal free only, Hard 100, Expert and Crazy 7 1,000; `Room.capStake` lowers it when a bot joins or the level drops); bots pay nothing, a person who wins takes every seat's stake, coins lost to a bot are gone. Bots decide only from `room.view(botId)`, public events and each person's saved habits from past games (`Member.habits`, read with the account at join and before each Bluff deal with bots), never another hand or the cards of the current play (a test checks a decision doesn't change when only those change), and never touch the database during a game. Habits are server-only: never put them in `PublicUser`, profiles or `RoomView`.
- People get at least 2 s to call a play before a bot's own move (`CALL_WINDOW` in `bots/driver.ts`). When tuning the engine, check behaviour with a simulation (person win %, lie %, call % by claim size, call accuracy, peek hits, levels against each other), not by eye; keep `test/bots-detector.test.ts` passing.
- `friend:online` goes to online friends when an account comes back after 5+ minutes away, never in the first 2 minutes after a server start (`OnlineAlertTimes` in `socket.ts`).
- New room settings default to **off** and must accept older apps that don't send them (see `parseConfig`). `config.game` picks Bluff or Crazy 7; Crazy 7 forces Bluff's extras off.
- Code that works for both games goes through `room.table`; Bluff-only code uses `room.game`, Crazy 7 `room.c7`.
- Seated players never get another player's cards (except 2v2 partners via `partnerHand`). Add a test when touching `view()`.
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
