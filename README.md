# Aftershock — 余震

*Made by Frank.*

A multiplayer earthquake run-for-life in a cel-shaded Japanese town. Up to
**30** runners share one quake timeline: the ground splits into fissures,
debris rains from rooftops, houses collapse into the street and runaway cars
tear down the lanes. Dodge, sprint, jump — last one standing wins.

Three.js (sakura-crossing construction method) + PINOC Gaussian-splat
characters (`@viggle/splat-engine` / PlayCanvas) + a small Node WebSocket
room server.

## Run

```bash
npm install
node server/index.js                         # WS room on :19090 (PORT / HOST env)
node node_modules/vite/bin/vite.js           # dev client on http://127.0.0.1:19078
```

Production-ish: `node node_modules/vite/bin/vite.js build`, then
`node node_modules/vite/bin/vite.js preview` (:19079, expects WS on :19090).
If the server isn't reachable the client falls back to **solo offline** after
~2.5 s. Override the WS URL with `?ws=ws://host:19090` or `VITE_WS_URL`.

On spark the user units `aftershock-server.service` (WS :19090) and
`aftershock.service` (`vite preview` of `dist/` on :19079) run it; rebuild and
restart both (only restart the room when `/health` shows no players).

## Controls

| Desktop | Mobile |
|---|---|
| WASD walk · Shift run · Space jump · mouse orbit | Stick walk · RUN · JUMP · drag orbit |

Login card: name + character (Kenji / Aoi), auto full screen on join, full
screen toggle in the top bar. Corner minimap shows streets, open fissures and
survivors.

## Rounds

- **Versus** (2+ players when the round starts): ends when one runner is left
  standing — they win and rank first.
- **Solo** (1 player): ends when you die or after a **10:00** cap (countdown
  chip at the top). Offline solo uses the same cap.
- Joining while a round is running → **observer** (birdview / follow) until it
  ends; observers aren't ranked.
- Losing pulls the camera up into a birdview of the whole town with marker
  pillars over survivors; click / tap cycles following survivors.
- The leaderboard stays up until *Play again* (which readies you in the
  lobby); the next-round countdown runs under it.

## Rules & hazards

- 3 lives. Hit or fall → red screen flash (~2.5 s) and a life lost.
- Sprint drains energy; at empty you drop to a walk until you release sprint
  and recover 25 %.
- Jump: ~0.95 m apex, ~0.7 s airtime, costs 6 % energy — clears bins and
  narrow cracks; you only fall into a fissure if you land in it.
- Telegraphs (1 s): a closing red target ring + growing shadow for falling
  objects, the exact red outline for fissures, creaking + shaking + a red
  blast zone for houses,
  honk + red lane chevrons (1.2 s) for runaway cars.
- **Difficulty curve** (`intensity()` in `src/world/disaster.js`, on the
  shared round clock): calm start (intensity 0.4 → ~1.0 at 30 s), ~2.0 at
  2 min (the old "doubled" level), ~2.8 at 5 min, ~3.6 at 10 min. It scales
  hazard frequency, the per-zone fissure / object caps and the extra crack /
  debris rolls; collapses start at 25 s, runaway cars at 40 s. The HUD shows
  it as a shindo badge (震度 1–7) with a toast when it steps up.
- Collapsed houses become low walkable **rubble heaps** — and hazard targets
  (3× weight per area, from the moment of collapse): objects land on them and
  fissures cut through them, swallowing the rubble. No safe havens.
- Fissures: `pit`, `chasm` and narrow `crack`; per-zone cap ramps 4 → 12 (64
  map-wide, packed in a data texture for the ground-cut shader), 60 s each.
- Fallen objects, collapse rubble and car wrecks stay **solid for 90 s**
  (per-zone cap ramps 24 → 80); a fissure opening under them swallows them.
- A collapsing house hits everyone within its **blast reach** beyond the
  footprint (~2.7 m for 1 floor → ~5.3 m for 3 floors), shown as a red
  rounded zone with a closing ring during the 1.1–1.5 s telegraph, and
  throws them outward.
- **Fire** ignites at houses (their frontage, or the rubble once they've
  fallen) and **never goes out**; standing in it costs a life. Warned by a
  floating ⚠ flame sign + orange ring (1.6 s). Up to 2 → 8 per zone as the
  intensity rises; orange dots on the minimap; crackle bed near flames.
- **Explosions**: gas leaks at house fronts (⚠ blast sign + red radius,
  1.7 s; half of them also start a fire) and red hazard drums that fall with
  the debris and blow up 2.4 s after landing (sign + radius during the fuse).
  A blast hits and throws everyone in its 2.6–3.4 m radius.
- Runaway cars hit anything they sweep over along the whole lane (swept test,
  so fast cars or slow frames can't skip you), fishtail as they slide, and the
  crash itself hits within 2.2 m.
  Collapses throw more rubble and spill more falling objects as it intensifies.
- Players, street clutter (bins, planters, bikes, cones), parked cars and
  wrecks are solid.

## Map

120 m square town on a 3×3 street grid: two 5.2 m boulevards crossing at a
central plaza with a clock monument, four 3.8 m side streets, 1 m sidewalks.
Every block is split by a walkable 3 m back lane with narrow house rows on
both the road frontage and the lane (~300 collapsible houses, batched one mesh
per material per block), parked kei trucks / sedans / vans along the kerbs.
30 spread-out spawn slots (`spawnPoints()` in `src/world/street.js`); the
server assigns `slot`. The chase camera pulls in front of walls in narrow
streets.

## Characters

Kenji (`aftershock-hero-sheet.jpg`) and Aoi (`aftershock-heroine-sheet.jpg`,
concept art from the grok CLI `image_edit` using Kenji's sheet as the style
reference), sent in `join.gender`. Both are PINOC Gaussian-splat characters
(`public/character/aftershock-{hero,heroine}.{high,performance}.vsplat`; Aoi =
PINOC asset `85fd5ff8-815a-47f6-89e2-3226f40e2a90`, built from the concept
sheet). Motions are PINOC library clips (idle / walk / run / hit / Jump /
Run Jump; jumps sped up ~2.2× to fit the hop). A missing splat or clip falls
back to the procedural body / pose automatically.

## Multiplayer & determinism

| Dir | Type | Purpose |
|-----|------|---------|
| C→S | `join` | `{ name, gender, clientId? }` — `full` at 30 |
| S→C | `welcome` | `{ id, phase, seed, startedAt, serverNow, lobby, players[] }` |
| S→C | `lobby` | lobby snapshot (players, ready, countdown) |
| C→S | `ready` | ready up |
| S→C | `roundStart` | `{ seed, startedAt, serverNow, mode, endsAt, players[] (slot, gender), spectate? }` |
| C→S | `state` | `{ x,y,z, facing, yaw, moving, run, air, alive, lives, score, survived }` ~20 Hz |
| S→C | `states` | batched peer snapshots ~20 Hz |
| S→C | `roundEnd` | `{ scores[], reason, mode, winnerId }` |

The server sends one room `seed` + `startedAt` (+ `serverNow` for clock
offset). Every client drives the disaster from `roomElapsed` with a
deterministic scheduler: five zones (plaza + 4 quadrants) each run a seeded
clock, events are processed in time order, and placement only reads an
event-time log — so late joiners fast-forwarding reproduce exactly the same
fissures, drops, collapses and cars. Falling objects, rubble flight and car
paths are closed-form in time; cosmetic randomness uses per-entity RNGs.
Hits are resolved locally.

Fissures share one analytic outline (`src/world/fissureShape.js`) between the
ground-cut shader (`holePunch.js`), the 6.5 m shaft mesh, the warning decal
and the kill test. Debug hooks: `__aftershockSpawnFissure(x, z, kind)`,
`__aftershockSpawnDrop(x, z)`, `__aftershockSpawnCar(x, z)`,
`__aftershockCollapseNear(x, z)`, `__aftershockSpawnFire(x, z)`,
`__aftershockSpawnBlast(x, z)`, `window.__aftershock`.

## Audio

SFX were generated with **Stable Audio Open 1.0** (`scripts/sfx/generate.py`:
3–4 candidates per prompt, best picked by CLAP similarity; the diffusers
Brownian-tree noise sampler is swapped for plain Gaussian noise because it
recurses forever / NaNs on this stack), then `scripts/sfx/finish.sh` trims,
fades, loudness-normalises and encodes to `public/audio/sfx/*.mp3` (the rumble
becomes a seamless loop via `loop.py`). `src/core/sfx.js` plays them
positionally (distance + stereo pan) and drives the rumble bed from quake
intensity; muted together with the BGM button.

## Limits

- Soft cap **30** concurrent sockets; the 31st gets the `full` screen.
- No accounts/passwords — display name + `localStorage` client id.
- Hits and collapse kill volumes are resolved client-side (same timeline,
  local resolution).
