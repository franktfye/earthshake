#!/usr/bin/env node
/**
 * Aftershock multiplayer room server (WebSocket).
 * Cap: 30 players. Shared disaster via room seed + startedAt.
 *
 * Protocol (JSON):
 *  C→S  join    { type:'join', name, clientId? }
 *  C→S  state   { type:'state', x,y,z, facing, yaw, moving, run, alive }
 *  C→S  chat?   (unused)
 *  S→C  welcome { type:'welcome', id, seed, startedAt, players:[{id,name,x,y,z,...}] }
 *  S→C  full    { type:'full', message }
 *  S→C  join    { type:'join', player }
 *  S→C  leave   { type:'leave', id }
 *  S→C  states  { type:'states', players:[{id,x,y,z,facing,yaw,moving,run,alive}] }
 */
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const MAX_PLAYERS = 30;
const TICK_MS = 50; // 20 Hz broadcast
const WORLD_SEED = 20241019;

const players = new Map(); // id → { id, name, ws, x, y, z, facing, yaw, moving, run, alive }
let startedAt = Date.now();
const roomSeed = WORLD_SEED;

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
    x: p.x, y: p.y, z: p.z,
    facing: p.facing, yaw: p.yaw,
    moving: p.moving, run: p.run,
    alive: p.alive,
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

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      players: players.size,
      max: MAX_PLAYERS,
      seed: roomSeed,
      startedAt,
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
      const id = (typeof msg.clientId === 'string' && /^[a-f0-9]{8,24}$/i.test(msg.clientId))
        ? msg.clientId
        : newId();
      // if reconnect with same id, drop old socket
      if (players.has(id)) {
        try { players.get(id).ws.close(); } catch { /* */ }
        players.delete(id);
      }
      const name = sanitizeName(msg.name);
      me = {
        id, name, ws,
        x: -18 + (players.size % 5) * 1.2,
        y: 0.1,
        z: (players.size % 3) * 1.1 - 1.1,
        facing: -Math.PI / 2,
        yaw: -Math.PI / 2,
        moving: 0,
        run: false,
        alive: true,
      };
      players.set(id, me);
      send(ws, {
        type: 'welcome',
        id,
        seed: roomSeed,
        startedAt,
        max: MAX_PLAYERS,
        players: [...players.values()].filter((p) => p.id !== id).map(publicPlayer),
      });
      broadcast({ type: 'join', player: publicPlayer(me) }, id);
      console.log(`[join] ${name} (${id}) — ${players.size}/${MAX_PLAYERS}`);
      return;
    }

    if (!me) return;

    if (msg.type === 'state') {
      me.x = Number(msg.x) || me.x;
      me.y = Number(msg.y) || me.y;
      me.z = Number(msg.z) || me.z;
      me.facing = Number(msg.facing) || 0;
      me.yaw = Number(msg.yaw) || 0;
      me.moving = Number(msg.moving) || 0;
      me.run = !!msg.run;
      me.alive = msg.alive !== false;
      return;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    players.delete(me.id);
    broadcast({ type: 'leave', id: me.id });
    console.log(`[leave] ${me.name} (${me.id}) — ${players.size}/${MAX_PLAYERS}`);
    me = null;
  });
});

setInterval(() => {
  if (!players.size) return;
  const list = [...players.values()].map(publicPlayer);
  broadcast({ type: 'states', players: list });
}, TICK_MS);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[aftershock] WS server on :${PORT} (max ${MAX_PLAYERS}) seed=${roomSeed}`);
});
