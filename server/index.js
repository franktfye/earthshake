#!/usr/bin/env node
/**
 * Aftershock multiplayer room server (WebSocket).
 * Cap: 30. Phases: lobby → playing → roundEnd → lobby.
 *
 * Protocol (JSON):
 *  C→S  join     { type:'join', name, clientId? }
 *  C→S  ready    { type:'ready' }
 *  C→S  state    { type:'state', x,y,z, facing, yaw, moving, run, alive, lives, score? }
 *  S→C  welcome  { type:'welcome', id, phase, max, lobby }
 *  S→C  full     { type:'full', message }
 *  S→C  lobby    { type:'lobby', ...lobbyState }
 *  S→C  roundStart { type:'roundStart', seed, startedAt }
 *  S→C  roundEnd { type:'roundEnd', scores:[{id,name,score,survived}] }
 *  S→C  join/leave/states (during play)
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = 30;
const TICK_MS = 50;
const WORLD_SEED = 20241019;
const LOBBY_MS = 60_000;
const ALL_READY_MS = 5_000;
const ROUND_END_HOLD_MS = 6_000;

const players = new Map();
let phase = 'lobby'; // lobby | playing | roundEnd
let roomSeed = WORLD_SEED;
let startedAt = 0; // round play clock
let lobbyEndsAt = Date.now() + LOBBY_MS;
let lobbyMode = 'wait'; // wait | starting
let roundEndTimer = null;

function sanitizeName(raw) {
  let s = String(raw ?? '').trim().slice(0, 16);
  s = s.replace(/[^\p{L}\p{N}_\- .]/gu, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) s = 'Runner';
  return s.slice(0, 16);
}

function newId() {
  return randomBytes(6).toString('hex');
}

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    ready: !!p.ready,
    x: p.x, y: p.y, z: p.z,
    facing: p.facing, yaw: p.yaw,
    moving: p.moving, run: p.run,
    alive: p.alive,
    lives: p.lives ?? 3,
    score: p.score ?? 0,
    survived: p.survived ?? 0,
  };
}

function lobbySnapshot() {
  return {
    type: 'lobby',
    phase,
    max: MAX_PLAYERS,
    filled: players.size,
    mode: lobbyMode,
    endsAt: lobbyEndsAt,
    serverNow: Date.now(),
    players: [...players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      ready: !!p.ready,
    })),
  };
}

function broadcast(msg, exceptId = null) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) {
    if (exceptId && p.id === exceptId) continue;
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastLobby() {
  broadcast(lobbySnapshot());
}

function resetLobbyTimer(ms = LOBBY_MS) {
  lobbyMode = 'wait';
  lobbyEndsAt = Date.now() + ms;
}

function allConnectedReady() {
  if (players.size < 1) return false;
  for (const p of players.values()) {
    if (!p.ready) return false;
  }
  return true;
}

function maybeStartFromReady() {
  if (phase !== 'lobby') return;
  if (!allConnectedReady()) return;
  if (lobbyMode === 'starting') return;
  lobbyMode = 'starting';
  lobbyEndsAt = Date.now() + ALL_READY_MS;
  broadcastLobby();
  console.log(`[lobby] all ready — ${ALL_READY_MS / 1000}s to start`);
}

function beginRound() {
  if (phase === 'playing') return;
  phase = 'playing';
  lobbyMode = 'wait';
  startedAt = Date.now();
  roomSeed = WORLD_SEED + (startedAt % 100000);
  for (const p of players.values()) {
    p.ready = false;
    p.alive = true;
    p.lives = 3;
    p.score = 0;
    p.survived = 0;
    p.x = -18 + (Math.random() * 4 - 2);
    p.z = Math.random() * 2 - 1;
    p.y = 0.1;
  }
  broadcast({
    type: 'roundStart',
    seed: roomSeed,
    startedAt,
    max: MAX_PLAYERS,
    players: [...players.values()].map(publicPlayer),
  });
  console.log(`[round] start seed=${roomSeed} players=${players.size}`);
}

function endRound() {
  if (phase !== 'playing') return;
  phase = 'roundEnd';
  const scores = [...players.values()]
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: Math.floor(p.score || 0),
      survived: Math.floor(p.survived || 0),
    }))
    .sort((a, b) => b.score - a.score);
  broadcast({ type: 'roundEnd', scores });
  console.log(`[round] end — ${scores.length} scores`);
  if (roundEndTimer) clearTimeout(roundEndTimer);
  roundEndTimer = setTimeout(() => {
    phase = 'lobby';
    for (const p of players.values()) {
      p.ready = false;
      p.alive = true;
      p.lives = 3;
    }
    resetLobbyTimer(LOBBY_MS);
    broadcastLobby();
    console.log('[lobby] reopened after round');
  }, ROUND_END_HOLD_MS);
}

function livingCount() {
  let n = 0;
  for (const p of players.values()) {
    if (p.alive && (p.lives ?? 0) > 0) n += 1;
  }
  return n;
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      phase,
      players: players.size,
      max: MAX_PLAYERS,
      seed: roomSeed,
      startedAt,
      lobbyEndsAt,
      lobbyMode,
    }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('Aftershock multiplayer WS — connect via WebSocket\n');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let me = null;

  ws.on('message', (buf) => {
    let msg;
    try { msg = JSON.parse(String(buf)); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      if (me) return;
      if (players.size >= MAX_PLAYERS) {
        send(ws, { type: 'full', message: 'Server full (30/30). Try again later.' });
        ws.close(4000, 'full');
        return;
      }
      // Mid-round join: allow into lobby wait only if not playing — during play, still join as spectator-ready for next; for MVP join lobby always and wait if playing
      const id = (typeof msg.clientId === 'string' && /^[a-f0-9]{8,24}$/i.test(msg.clientId))
        ? msg.clientId
        : newId();
      if (players.has(id)) {
        try { players.get(id).ws.close(); } catch { /* */ }
        players.delete(id);
      }
      const name = sanitizeName(msg.name);
      me = {
        id, name, ws,
        ready: false,
        x: -18 + (players.size % 5) * 1.2,
        y: 0.1,
        z: (players.size % 3) * 1.1 - 1.1,
        facing: -Math.PI / 2,
        yaw: -Math.PI / 2,
        moving: 0,
        run: false,
        alive: true,
        lives: 3,
        score: 0,
        survived: 0,
      };
      players.set(id, me);

      // New lobby join refreshes 1-minute timer (cancels 5s start)
      if (phase === 'lobby') {
        resetLobbyTimer(LOBBY_MS);
      }

      send(ws, {
        type: 'welcome',
        id,
        phase,
        max: MAX_PLAYERS,
        seed: roomSeed,
        startedAt,
        lobby: lobbySnapshot(),
        players: [...players.values()].filter((p) => p.id !== id).map(publicPlayer),
      });

      if (phase === 'lobby') {
        broadcastLobby();
      } else if (phase === 'playing') {
        // Late join mid-round: spectator until round ends (lives=0, alive=false)
        me.alive = false;
        me.lives = 0;
        me.ready = false;
        broadcast({ type: 'join', player: publicPlayer(me) }, id);
        send(ws, {
          type: 'roundStart',
          seed: roomSeed,
          startedAt,
          max: MAX_PLAYERS,
          spectate: true,
          players: [...players.values()].map(publicPlayer),
        });
      } else {
        broadcastLobby();
      }

      console.log(`[join] ${name} (${id}) — ${players.size}/${MAX_PLAYERS} phase=${phase}`);
      return;
    }

    if (!me) return;

    if (msg.type === 'ready') {
      if (phase !== 'lobby') return;
      me.ready = true;
      broadcastLobby();
      maybeStartFromReady();
      return;
    }

    if (msg.type === 'state') {
      if (phase !== 'playing') return;
      me.x = Number(msg.x) || me.x;
      me.y = Number(msg.y) || me.y;
      me.z = Number(msg.z) || me.z;
      me.facing = Number(msg.facing) || 0;
      me.yaw = Number(msg.yaw) || 0;
      me.moving = Number(msg.moving) || 0;
      me.run = !!msg.run;
      me.alive = msg.alive !== false;
      if (msg.lives != null) me.lives = Math.max(0, Math.min(3, Number(msg.lives) || 0));
      if (msg.score != null) me.score = Number(msg.score) || me.score;
      if (msg.survived != null) me.survived = Number(msg.survived) || me.survived;
      if (me.lives <= 0) me.alive = false;
      return;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    players.delete(me.id);
    broadcast({ type: 'leave', id: me.id });
    console.log(`[leave] ${me.name} (${me.id}) — ${players.size}/${MAX_PLAYERS}`);
    me = null;
    if (phase === 'lobby') {
      broadcastLobby();
      maybeStartFromReady();
    } else if (phase === 'playing' && players.size > 0 && livingCount() === 0) {
      endRound();
    } else if (players.size === 0) {
      phase = 'lobby';
      resetLobbyTimer(LOBBY_MS);
    }
  });
});

setInterval(() => {
  const now = Date.now();

  if (phase === 'lobby' && players.size > 0) {
    if (now >= lobbyEndsAt) {
      beginRound();
      return;
    }
  }

  if (phase === 'playing') {
    if (players.size > 0 && livingCount() === 0) {
      endRound();
      return;
    }
    const list = [...players.values()].map(publicPlayer);
    broadcast({ type: 'states', players: list, phase, startedAt, serverNow: now });
  }
}, TICK_MS);

// Lobby heartbeat so clients stay synced on countdown
setInterval(() => {
  if (phase === 'lobby' && players.size > 0) broadcastLobby();
}, 1000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[aftershock] WS :${PORT} max=${MAX_PLAYERS} lobby=${LOBBY_MS / 1000}s`);
});
