# Bluff backend

Real-time server for the Bluff card game (Node + Socket.IO). It holds every game in memory, checks every move, and sends each player only their own hand.

## Run locally

```bash
npm install
npm run dev      # http://localhost:3001  (restarts on file changes)
npm test         # game rules + socket tests
```

## Deploy on Render (free)

1. Push this folder to its own GitHub repo.
2. Render → **New → Web Service** → connect the repo, then set:
   - Runtime **Node**, Build `npm ci --include=dev && npm run build`, Start `npm start`, Instance **Free**
   - Health check path `/health`
   - (Or **New → Blueprint**; `render.yaml` fills these in.)
3. Environment variable `CLIENT_ORIGIN` = your Vercel URL, e.g. `https://my-bluff.vercel.app` (comma-separate several).
4. Copy the service URL (`https://<name>.onrender.com`) into the frontend's `VITE_SERVER_URL`.

## Good to know

- Free instances sleep after 15 min without traffic; the first connection after that takes up to about a minute.
- Rooms live in memory: a redeploy or restart ends running games, and players land back on the home screen. Don't deploy while friends are playing.
- Without `CLIENT_ORIGIN` only localhost and home-network (192.168.x / 10.x / 172.16–31.x) pages can connect.
- Limits: 5 players per room, 200 rooms, 40 events per 10 s per connection, names up to 16 characters.

## Code map

| File | What it does |
|---|---|
| `src/game.ts` | Game rules: deal, play, pass, bluff (both rules), finishing order |
| `src/rooms.ts` | Rooms, seats, host, lobby settings, spoken announcement text |
| `src/socket.ts` | Socket events, per-player state, rate limit, rejoin |
| `src/validate.ts` | Checks every incoming payload |
| `src/types.ts` | Shapes shared with the frontend (copy kept in `bluff-frontend/src/types.ts`) |

## Socket events

| Client → server | Payload |
|---|---|
| `room:create` | `{ name }` → `{ code, token }` |
| `room:join` | `{ code, name }` → `{ code, token }` |
| `room:rejoin` | `{ code, token }` |
| `room:config` | `{ decks: 1 \| 2, bluffRule: 'all' \| 'one' }` (host, lobby) |
| `room:start` / `room:lobby` / `room:leave` | – |
| `game:play` | `{ cardIds, rank? }` (rank only when starting a round) |
| `game:pass` | – |
| `game:bluff` | `{ playId, cardIndex? }` (`cardIndex` for the "pick one" rule) |

Server → client: `state` (that player's `RoomView`), `announce` (`{ kind, text }`, read aloud by the app), `session:replaced`.
