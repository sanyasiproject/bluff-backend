# Bluff backend

Real-time server for the Bluff card game (Node + Socket.IO + Express). It holds every game in memory, checks every move, and sends each player only their own hand. With MongoDB configured it also has accounts, coins, an admin API and saved game history; without it, everyone plays as a guest.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3001  (restarts on file changes)
npm test         # game rules + socket tests (account tests are skipped)
TEST_MONGODB_URI=mongodb://127.0.0.1:27099 npm test   # also runs the account tests on a throwaway database
```

For accounts locally, copy `.env.example` values into your shell (at least `MONGODB_URI`).

## Deploy on Render (free)

1. Push this folder to its own GitHub repo.
2. Render → **New → Web Service** → connect the repo, then set:
   - Runtime **Node**, Build `npm ci --include=dev && npm run build`, Start `npm start`, Instance **Free**
   - Health check path `/health`
   - (Or **New → Blueprint**; `render.yaml` fills these in.)
3. Environment variables: see the table below. `CLIENT_ORIGIN` = your Vercel URL.
4. Copy the service URL (`https://<name>.onrender.com`) into the frontend's `VITE_SERVER_URL`.

## Environment variables

| Name | Example | Needed for |
|---|---|---|
| `CLIENT_ORIGIN` | `https://bluff-frontend.vercel.app` | browsers allowed to connect (comma-separated) |
| `NODE_VERSION` | `22` | Render's Node version |
| `MONGODB_URI` | `mongodb+srv://…` (secret) | accounts; empty = guest-only |
| `VAPID_PUBLIC_KEY` | `BEl6…` (from `npx web-push generate-vapid-keys`) | friend-invite notifications; empty = off |
| `VAPID_PRIVATE_KEY` | `x3Kq…` (secret, same command) | friend-invite notifications |
| `VAPID_SUBJECT` | `mailto:you@example.com` or `https://bluff-frontend.vercel.app` | how push services can reach you; defaults to the first `CLIENT_ORIGIN` |

Everything else has a built-in default: database `bluff`; collections `users`, `sessions`, `games`, `audit_log`, `friends`, `settings`, `push_subscriptions` (created with their indexes on first start); 1000 starting coins; logins last 30 days.

## Friend-invite notifications (Web Push)

- When a friend is offline, **Invite** reaches their phone as a notification (if they turned it on in their Profile). Tapping it opens `/?room=CODE`. Online friends get the in-app popup as before.
- Works on Android browsers and the installed app, desktop Chrome/Edge/Firefox, and on iPhone/iPad (iOS 16.4+) only in the app added to the Home Screen.
- **Set up once:** run `npx web-push generate-vapid-keys` on your computer, then add `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and (optionally) `VAPID_SUBJECT` in Render → Environment, and redeploy. Keep the private key secret; changing the keys later means everyone must turn notifications on again. Nothing is needed on Vercel: the app reads the public key from `/api/push/key`.
- Each phone is a row in `push_subscriptions` (account, the push service address and its two keys). Logging out removes that phone; addresses the push service reports gone (404/410) are deleted on the next send. The server only posts to the browsers' own push services (Google, Mozilla, Microsoft, Apple).
- **Admin switch:** Admin → Invite notifications on/off (`pushInvites` in `/api/admin/settings`), saved and logged like Guest play. While off, offline friends just get the WhatsApp hint and phones can't sign up; phones already signed up stay saved.
- The same friend can be invited at most once every 30 s. An invite notification expires after 10 minutes if the phone stays offline.

## Coins

- New accounts get 1000 coins. **+200** on the first login (or app open) of each India-time day, sign-up day included.
- **Daily games ladder** (IST day, win or lose): reaching 1 / 3 / 5 / 10 / 20 / 50 finished games pays +100 / +300 / +500 / +1,000 / +2,000 / +5,000 (up to 8,900 a day). Only games of 1 minute or more count (`DAILY_GAME_REWARDS`, `MIN_REWARD_GAME_SEC` in `src/types.ts`).
- **Peek power** (0–3 per player per game), **bets on bluff calls** (paid with the stake when the game finishes, never below zero) and **2v2 teams** (4 slots, 🔵 0 & 2 vs 🟠 1 & 3, chosen or swapped in the lobby; partners see each other's hand; the first team with both partners out wins and splits the pot; partners can't challenge each other; removing a player stops the game).
- **Levels** come from lifetime XP (`XP_RULES`, `levelOf` in `src/types.ts`): +20 per finished game, +50 for a win, +5 per caught liar, +3 per bluff nobody caught. Level *n* needs 50 × (*n*−1) × *n* XP; titles run from Rookie (1) to Legend (50, 122,500 XP) and live in the frontend's `src/lib/progress.ts`.
- **Stakes** (host picks in the lobby): Free, 50, 100, 250, 500, 1K, 5K, 10K, 50K, 1L, 5L, 10L per player. Start checks everyone can pay; guests can only play Free games.
- Coins move only when a game **finishes**: every logged-in player pays the stake and the winner (1st place) gets the whole pot. A game stopped by the host, or by kicks leaving one player before anyone finished, moves nothing. A kicked player pays nothing and wins nothing. A player who uses **Leave game** mid-game forfeits: they lose and still pay the stake (in 2v2 their team loses; if one player is left, they win).
- Every finished game stores the stake, pot and each player's coin change in `games`.
- **Bots** have no coins. With a bot seated the stake is at most 100 (`BOT_MAX_STAKE`; adding a bot lowers a higher stake). People pay in as usual; bots put in nothing, but their seats count: a person who wins takes the stake for every seat. If a bot wins, the people's stakes are simply gone. Bets work the same way (lost to a bot: gone; won from a bot: paid in full). Bot games count for XP, stats and the daily ladder like any other.
- **Gifts:** friends can give each other 10 / 25 / 50 / 100 coins, at most 100 a day in total per giver (one atomic update checks balance and limit). Both sides get an audit entry (`gift`), shown in the admin history. `PublicUser.giftLeft` says what's left today.

## Crazy 7 (second game)

The host picks the game in the lobby (`config.game`: `bluff`, the default, or `crazy7`). Rooms, seats (2–5), watchers, bots, stakes,
XP, the daily ladder, kicks, leaving and Stop game work the same for both.

- 5 or 7 cards each (`handSize`), 1 or 2 decks; the rest is the face-down deck and its top card starts the pile (never a 7).
- On your turn play ONE card of the top card's suit or number. With no matching card the server picks one for you; after that you
  may pick more, up to `maxPicks` (1–7) in the turn. Pass only stops picking early: it needs at least one pick and more picks still
  allowed, so a 1-pick room has no Pass, and at the limit a card that fits must be played. Reaching the limit with nothing to play
  passes the turn by itself. You may also pick on purpose while you could play.
- A 7 makes the next player pick 2 and lose the turn. With `stack7` on they can answer with their own 7 and the next player picks 4,
  then 6…; everyone facing a pick taps Pick N themselves (`c7:pick`), so a pause never shows who holds a 7. With stacking off the pick
  is taken for them.
- Going down to one card, say "last card" (`c7:call`): on your turn with two cards, or right after, until ANOTHER player makes a
  deliberate move (play, pick or pass). If the turn comes back through automatic steps, nobody caught you. Caught: on your next turn
  you pick 1 (plus any waiting 7 pick) and miss the turn. Bots wait at least 3.5 s while a person is at risk, and sometimes forget too.
- The first player out wins at once; everyone else loses (the stake works as in Bluff). An empty deck is refilled from the pile; if
  nobody can play and nothing is left to pick, the fewest cards win.
- Bluff's extras (bluff rule, peeks, bets, teams) stay in the settings but are ignored in Crazy 7; End game doesn't apply.
- Lifetime stats count Crazy 7 games in `crazy7Games` (Bluff bots read only Bluff games); Crazy 7 picks don't count as cards picked up.
- Code: `src/crazy7/game.ts` (rules), `src/crazy7/driver.ts` + `brain.ts` + `memory.ts` (bots that search ahead from what they've seen).

## Rules worth knowing

- **Bots** (`src/bots/`): the host adds them in the lobby (`room:addBot`). A person must be seated to start; when the last person leaves, the bots go and the room closes; once no person holds cards, the game ends at once (2v2 plays on). Bots can't host, watch or be invited; in 2v2 they accept swaps at once. They pause while no person is connected.
- **Bot engine**: each bot draws its own numbers from one of six styles (shark, maniac, rock, detective, trickster, gambler; never two of the same at a table) and drifts a little every game. It decides only from `room.view(botId)` (exactly what a seated player gets) plus its own memory of public events: card counting with its own cards, piles it saw picked up or discarded, and a read on every player (lie rate, call rate, call accuracy) from their lifetime stats (read once at join into `Member.stats`, never during a game) and what it saw at the table. Choices are weighted at random, and think time is drawn before deciding, so a pause never gives a lie away. `test/bots.test.ts` plays hundreds of bot games through the real rules.
- New lifetime stats `plays` and `chances` (plays by others you could have called) feed the bots' read on each player; older accounts fall back to estimates.
- A player can call **Bluff at most 2 times in a row**; after that the call is refused until they play or pass on their own turn (`MAX_BLUFF_CALLS_IN_A_ROW` in `src/types.ts`).
- New rooms start on the **pick one card** bluff rule; the host can switch to show all in the lobby.

`/health` answers `{"ok":true,"accounts":"on","guests":true}` when the database is connected (`guests` is false while an admin has guest play turned off).

- **Guest play switch:** with guest play off, guests get "Guest play is off right now. Log in to play" on `room:create` / `room:join`. Guests already in a room keep their seat and can `room:rejoin`.

## Accounts API

All bodies are JSON. Protected routes need `Authorization: Bearer <token>` (the token from register/login).

| Method & path | Who | Body / query | Returns |
|---|---|---|---|
| `POST /api/auth/register` | anyone | `{ username, password, displayName? }` | `{ token, user }` (201) |
| `POST /api/auth/login` | anyone | `{ username, password }` | `{ token, user, bonus }` |
| `POST /api/auth/logout` | logged in | – | 204, token revoked |
| `GET /api/me` | logged in | – | `{ user, bonus, friendRequests }` (bonus = daily +200 if just paid) |
| `GET /api/me/games` | logged in | `?limit=20` | `{ games }` most recent first, with per-game stats and coins |
| `GET /api/me/overview` | logged in | – | `{ coinRank, players, friends, loginBonusToday, gameBonusToday }` for the profile page |
| `GET /api/friends` | logged in | – | `{ friends, incoming, outgoing }` with `online`, `inRoom` and `roomPhase` (the stage of a friend's other room) |
| `GET /api/players/:username` | logged in | – | `{ profile }`: name, level, joined date, online (friends and yourself only, else `null`), game stats and friend status; never coins, role or login times |
| `GET /api/friends/search` | logged in | `?q=` (2+ letters; username start or display name) | `{ players }` with `level`, `online` (friends only, else `null`), `status` |
| `POST /api/friends/request` | logged in | `{ username }` | `{ result: 'sent' \| 'accepted' }` |
| `POST /api/friends/:id/accept` | logged in | – | 204 |
| `POST /api/friends/:id/remove` | logged in | – | 204 (decline, cancel or unfriend) |
| `GET /api/admin/users` | admin | `?search=&limit=50&skip=0` | `{ users, total }` |
| `GET /api/admin/users/:id` | admin | – | `{ user, games, history, historyTotal, friends, activeSessions }` (last 10 games, first page of admin changes) |
| `GET /api/admin/users/:id/history` | admin | `?page=1` | `{ history, total }`, 10 admin changes per page, newest first |
| `POST /api/admin/users/:id` | admin | any of `{ displayName, role: 'user' \| 'admin', blocked }` | `{ user }`; blocking logs them out everywhere; not on yourself |
| `POST /api/admin/users/:id/password` | admin | `{ password }` | 204; logs them out everywhere |
| `POST /api/admin/users/:id/coins` | admin | `{ amount, reason? }` (negative takes coins) | `{ user }` |
| `GET /api/admin/settings` | admin | – | `{ settings }`: `{ guestsAllowed, updatedBy, updatedAt }` |
| `POST /api/admin/settings` | admin | any of `{ guestsAllowed, pushInvites }` | `{ settings }`; saved in the `settings` collection, logged in the admin's history, every open app gets `settings:changed` |
| `GET /api/push/key` | anyone | – | `{ publicKey, enabled }`: null key = notifications not set up; `enabled` false = an admin switched invites off |
| `POST /api/push/subscribe` | logged in | the browser's `PushSubscription.toJSON()` | 204; this phone gets the account's invite notifications (503 while switched off) |
| `POST /api/push/unsubscribe` | logged in | `{ endpoint }` | 204 |
| `POST /api/admin/make-admin` | admin, or header `X-Admin-Key` | `{ username }` | `{ user }` |

Rules: usernames are 3–20 lowercase letters, numbers or `_`; passwords 8–128 characters; display names follow the in-game name rules (1–16 characters). Coins never go below zero. Login, register and make-admin allow 20 attempts per IP per 15 minutes. Search, player profiles and friend actions share a limit of 20 per minute per account (429 after that).

**Make the first admin:** sign up in the app, then in MongoDB (e.g. Atlas → Browse Collections → `users`) change your document's `role` from `"user"` to `"admin"`. After that, admins promote others from the app's Admin screen.

(Alternative without touching the database: set an `ADMIN_API_KEY` env var and call `POST /api/admin/make-admin` with header `X-Admin-Key: <key>` and body `{"username":"…"}`.)

## Security notes

- Passwords: scrypt with a random salt per user. Tokens: 256-bit random; only their SHA-256 hash is stored, and they expire via a TTL index.
- Logged-in players are identified from the socket handshake token; a missing or bad token just means guest.
- Admin actions are written to the audit collection with who did them and how (admin login or API key).
- Game saving runs in the background; a database error is logged and never stops a game.
- One room per account: joining or creating a room releases your old seat, unless it's open on another connection or you still hold cards in a running game there.
- Per network (client IP from `cf-connecting-ip`, else the last `X-Forwarded-For` entry, else the socket address): 50 connections, 10 new rooms per 10 minutes and 5 open rooms. Tune with `createBluffServer({ limits })`.
- Watchers see every hand, so after a game starts newcomers must be let in by the host (see `room:admit`).

## Good to know

- Free instances sleep after 15 min without traffic; the first connection after that takes up to about a minute.
- Rooms live in memory: a redeploy or restart ends running games, and players land back on the home screen. Don't deploy while friends are playing.
- Without `CLIENT_ORIGIN` only localhost and home-network (192.168.x / 10.x / 172.16–31.x) pages can connect.
- Limits: 5 players + up to 7 watchers per room (12 people, bots included), 200 rooms, 40 events per 10 s per connection, one chat message per 0.7 s, names up to 16 characters.
- When 5 are seated, newcomers watch; they take free seats when the room returns to the lobby. After a game has started, a join becomes a request the host approves; anyone still waiting is let in when the room returns to the lobby.
- Chat only sends an index into the fixed `REACTIONS` / `QUICK_MESSAGES` lists in `src/types.ts`, so there is no free text to moderate.

## Code map

| File | What it does |
|---|---|
| `src/game.ts` | Game rules: deal, play, pass, bluff (both rules), finishing order, per-player stats |
| `src/crazy7/` | Crazy 7: `game.ts` (rules), bots (`driver.ts`, `brain.ts`, `memory.ts`) |
| `src/bots/` | Bots: `personality.ts` (styles, names), `memory.ts` (what a bot saw), `brain.ts` (decisions), `driver.ts` (timers, moves through the same rules) |
| `src/rooms.ts` | Rooms, seats and watchers, host, lobby settings, chat throttle, game snapshots, spoken announcements |
| `src/awards.ts` | End-of-game awards (Biggest liar, Best detective, …) |
| `src/socket.ts` | Socket events, per-player state, login token check, saving finished games |
| `src/http/` | Express app, CORS, rate limit, `/api` routes |
| `src/services/` | `UserService` (accounts, sessions, coins, admin) and `GameRecorder` (games + stats) |
| `src/db/` | MongoDB connection, indexes, document shapes |
| `src/validate.ts` | Checks every incoming payload |
| `src/types.ts` | Shapes shared with the frontend (copy kept in `bluff-frontend/src/types.ts`) |

## Socket events

| Client → server | Payload |
|---|---|
| `room:create` | `{ name }` → `{ code, token }` (name ignored when logged in) |
| `room:join` | `{ code, name, watch? }` → `{ code, token }`, or `{ code, pending: true }` once a game has started (waits for the host). `watch`: join the lobby as a watcher |
| `friend:join` | `{ userId, watch? }` (logged in, friends only): join or watch the friend's room; once their game is on it's a request to the host, like `room:join` |
| `room:addBot` | – (host, lobby, free seat: a bot sits down; a stake over 100 drops to 100) |
| `room:cancelRequest` | – (withdraw a pending join request) |
| `room:admit` | `{ requestId, accept }` (host: let a pending request in to watch, or turn it down). After asking, or a no, the same account (a guest: network + name) waits 10 s before asking again |
| `room:rejoin` | `{ code, token }` |
| `room:config` | `{ game: 'bluff' \| 'crazy7', decks: 1 \| 2, bluffRule: 'all' \| 'one', stake, peeks: 0–3, bets: boolean, teams: boolean, handSize: 5 \| 7, maxPicks: 1–7, stack7: boolean }` (host, lobby; missing fields: Bluff, off, 7 cards, 1 pick, stacking on; Crazy 7 turns Bluff's extras off) |
| `room:start` / `room:lobby` / `room:leave` | – (`room:leave` mid-game with cards is a forfeit: a loss that still pays the stake) |
| `room:rematch` | – (host, after game over: same table, same settings, dealt again) |
| `room:end` | – (host, once someone finished 1st: game over, 1st wins and everyone else loses) |
| `room:host` | `{ memberId }` (host, lobby only: make an online member the host) |
| `room:teams` | – (host, lobby, 2v2 with 4 players: give slot 1 a different partner) |
| `room:slot` | `{ slot: 0–3 }` (2v2 lobby: move yourself to a free slot; 🔵 0 & 2, 🟠 1 & 3) |
| `room:swap` | `{ memberId }` (2v2 lobby: ask someone to swap places) |
| `room:swapAnswer` | `{ memberId, accept }` (answer a swap request from `memberId`) |
| `room:watch` | `{ watching: boolean, memberId? }` (lobby only: sit out and watch, or take a free seat; with `memberId` the host moves someone else; chosen watchers aren't seated automatically) |
| `game:play` | `{ cardIds, rank? }` (rank only when starting a round) |
| `game:pass` | – |
| `game:bluff` | `{ playId, cardIndex?, bet? }` (`cardIndex` for the "pick one" rule; `bet` from `BET_STEPS`, at most the stake, coin games with bets on) |
| `game:peek` | `{ playId, cardIndex }` → `{ card }` only to the player who peeks (rooms with peeks on) |
| `c7:play` | `{ cardId }` (Crazy 7, your turn: one card of the top card's suit or number; only a 7 while a pick waits) |
| `c7:pick` | – (Crazy 7, your turn: pick one card, up to `maxPicks` a turn; while a 7's pick waits, take it) |
| `c7:pass` | – (Crazy 7, your turn: stop picking early; only after a pick and while more picks are allowed) |
| `c7:call` | – (Crazy 7: "last card", with one card left, or on your turn with two) |
| `chat:send` | `{ kind: 'reaction' \| 'message', index }` |
| `chat:throw` | `{ to: memberId, index }` (index into `THROWS`; shares the chat speed limit) |
| `friend:gift` | `{ memberId \| userId, amount }` (logged in, friends only; amount from `GIFT_STEPS`; at most `DAILY_GIFT_LIMIT` = 100 coins given per IST day in total) → `{ coins, giftLeft }` |
| `room:kick` | `{ memberId }` (host only; mid-game the player's cards leave the game) |
| `friend:invite` | `{ userId }` (logged in, friends only, not already in a room; once per friend per 30 s) → `{}` when online (popup), `{ pushed: true }` when offline and a notification went to their phone(s) |

Connect with `io(url, { auth: { token } })` to play as a logged-in account. Server → client: `server:info` (`{ accounts, guestsAllowed }`, on every connection and to a guest who is turned away, so the app shows Log in and the guest lock even when its `/health` check is blocked), `state` (that player's `RoomView`), `announce` (`{ kind, text }`, read aloud), `chat` (`{ from, kind, index }`), `invite` (`{ fromId, fromName, code }`), `friends:changed` (someone sent, accepted or removed a friend request), `throw` (`{ from, to, index }`), `gift` (`{ from, to, amount }`, member ids, only when both are in the same room), `gift:received` (`{ fromName, amount }`, to whoever got coins), `watch:admitted` (`{ code, token, name }`: the host let you in, rejoin with it), `watch:denied` (`{ code, reason? }`), `room:kicked`, `session:replaced`. `RoomView.crazy7` carries the Crazy 7 table (top card, deck and pile counts, waiting pick, my playable cards and choices, who said last card, the last move). The host's `RoomView.watchRequests` lists pending requests (empty for everyone else). `RoomView.leftPlayers` lists who used Leave game in the current game (for names, the pot and the results), cleared back in the lobby.
