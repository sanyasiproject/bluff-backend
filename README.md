# Bluff backend

Real-time server for the Bluff card game (Node + Socket.IO + Express). It holds every game in memory, checks every move, and sends each player only their own hand. With MongoDB configured it also has accounts, coins, an admin API and saved game history; without it, everyone plays as a guest.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3001  (restarts on file changes)
npm test         # game rules + socket tests (account tests are skipped)
TEST_MONGODB_URI=mongodb://127.0.0.1:27017 npm test   # also runs the account tests on a throwaway database
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

Everything else has a built-in default: database `bluff`; collections `users`, `sessions`, `games`, `audit_log` (created with their indexes on first start); 1000 starting coins; logins last 30 days.

`/health` answers `{"ok":true,"accounts":"on"}` when the database is connected.

## Accounts API

All bodies are JSON. Protected routes need `Authorization: Bearer <token>` (the token from register/login).

| Method & path | Who | Body / query | Returns |
|---|---|---|---|
| `POST /api/auth/register` | anyone | `{ username, password, displayName? }` | `{ token, user }` (201) |
| `POST /api/auth/login` | anyone | `{ username, password }` | `{ token, user }` |
| `POST /api/auth/logout` | logged in | – | 204, token revoked |
| `GET /api/me` | logged in | – | `{ user }` with coins and stats |
| `GET /api/me/games` | logged in | `?limit=20` | `{ games }` most recent first |
| `GET /api/admin/users` | admin | `?search=&limit=50&skip=0` | `{ users, total }` |
| `POST /api/admin/users/:id/coins` | admin | `{ amount, reason? }` (negative takes coins) | `{ user }` |
| `POST /api/admin/make-admin` | admin, or header `X-Admin-Key` | `{ username }` | `{ user }` |

Rules: usernames are 3–20 lowercase letters, numbers or `_`; passwords 8–128 characters; display names follow the in-game name rules (1–16 characters). Coins never go below zero. Login, register and make-admin allow 20 attempts per IP per 15 minutes.

**Make the first admin:** sign up in the app, then in MongoDB (e.g. Atlas → Browse Collections → `users`) change your document's `role` from `"user"` to `"admin"`. After that, admins promote others from the app's Admin screen.

(Alternative without touching the database: set an `ADMIN_API_KEY` env var and call `POST /api/admin/make-admin` with header `X-Admin-Key: <key>` and body `{"username":"…"}`.)

## Security notes

- Passwords: scrypt with a random salt per user. Tokens: 256-bit random; only their SHA-256 hash is stored, and they expire via a TTL index.
- Logged-in players are identified from the socket handshake token; a missing or bad token just means guest.
- Admin actions are written to the audit collection with who did them and how (admin login or API key).
- Game saving runs in the background; a database error is logged and never stops a game.

## Good to know

- Free instances sleep after 15 min without traffic; the first connection after that takes up to about a minute.
- Rooms live in memory: a redeploy or restart ends running games, and players land back on the home screen. Don't deploy while friends are playing.
- Without `CLIENT_ORIGIN` only localhost and home-network (192.168.x / 10.x / 172.16–31.x) pages can connect.
- Limits: 5 players + up to 7 watchers per room (12 people), 200 rooms, 40 events per 10 s per connection, one chat message per 0.7 s, names up to 16 characters.
- People who join mid-game, or when 5 are seated, watch; they take free seats when the room returns to the lobby.
- Chat only sends an index into the fixed `REACTIONS` / `QUICK_MESSAGES` lists in `src/types.ts`, so there is no free text to moderate.

## Code map

| File | What it does |
|---|---|
| `src/game.ts` | Game rules: deal, play, pass, bluff (both rules), finishing order, per-player stats |
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
| `room:join` | `{ code, name }` → `{ code, token }` |
| `room:rejoin` | `{ code, token }` |
| `room:config` | `{ decks: 1 \| 2, bluffRule: 'all' \| 'one' }` (host, lobby) |
| `room:start` / `room:lobby` / `room:leave` | – |
| `game:play` | `{ cardIds, rank? }` (rank only when starting a round) |
| `game:pass` | – |
| `game:bluff` | `{ playId, cardIndex? }` (`cardIndex` for the "pick one" rule) |
| `chat:send` | `{ kind: 'reaction' \| 'message', index }` |

Connect with `io(url, { auth: { token } })` to play as a logged-in account. Server → client: `state` (that player's `RoomView`), `announce` (`{ kind, text }`, read aloud), `chat` (`{ from, kind, index }`), `session:replaced`.
