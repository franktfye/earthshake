# Aftershock — 余震

One-map earthquake run-for-life. Cel-shaded Three.js (sakura-crossing construction method) + optional WebSocket multiplayer (max **30**).

## Run (FUSE-safe)

```bash
cd game
npm run setup      # install deps into /tmp/aftershock
npm run server     # terminal A — WS room on :8787
npm run dev        # terminal B — client on http://127.0.0.1:5178
```

Open two browser windows → enter different names → **Join & run**. You should see each other’s third-person avatars + nametags.

If the server isn’t up, the client falls back to **solo offline** after ~2.5s.

Production-ish:

```bash
npm run build
npm run server
npm run preview    # :5179 — still expects WS on :8787
```

Override WS URL: `?ws=ws://host:8787` or `VITE_WS_URL`.

## Multiplayer protocol (sketch)

| Dir | Type | Purpose |
|-----|------|---------|
| C→S | `join` | `{ name, clientId? }` — reject with `full` at 30 |
| S→C | `welcome` | `{ id, seed, startedAt, players[] }` |
| S→C | `full` | server full message |
| S→C | `join` / `leave` | peer presence |
| C→S | `state` | `{ x,y,z, facing, yaw, moving, run, alive }` ~20 Hz |
| S→C | `states` | batched peer snapshots ~20 Hz |

**Hazards:** server sends one room `seed` + `startedAt`. Every client drives disaster from `roomElapsed = (now - startedAt) / 1000` with a **deterministic** scheduler (no player-relative picks). Late joiners catch up by fast-forwarding due events. Death is local; retry respawns you in the same room without rebuilding the shared map when online.

## Controls

| Desktop | Mobile |
|---|---|
| WASD, Shift run, mouse orbit | Stick + RUN / magnitude, drag orbit |

## Limits

- Soft cap **30** concurrent sockets; 31st gets `full` UI
- No accounts/passwords — display name + `localStorage` client id
- Debris hits / collapse kill volumes are still client-side (same timeline, local resolution)
