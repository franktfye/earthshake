import * as THREE from 'three';
import { PAL } from './core/palette.js';
import { Pipeline } from './core/post.js';
import { buildSky } from './core/sky.js';
import { setOutlineResolution } from './core/outline.js';
import { Player } from './core/player.js';
import { createHud } from './core/hud.js';
import { createControls } from './core/controls.js';
import { buildWorld, WORLD_SEED } from './world/index.js';
import { createNetClient } from './net/client.js';
import { createRemoteManager } from './net/remotes.js';
import { createBgm } from './core/bgm.js';
import { initPinocLayer } from './world/pinocLayer.js';

const HS_KEY = 'aftershock-best';

const canvas = document.getElementById('view');
const splatCanvas = document.getElementById('splat-view');
/** @type {null | Awaited<ReturnType<typeof initPinocLayer>>} */
let pinoc = null;

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: false,
  powerPreference: 'high-performance',
  stencil: false,
});
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.setClearColor(new THREE.Color(PAL.fog), 1);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(PAL.fog, 32, 110);

const camera = new THREE.PerspectiveCamera(48, 1, 0.2, 400);
camera.rotation.order = 'YXZ';

const sun = new THREE.DirectionalLight(PAL.sun, 2.25);
sun.position.set(-52, 62, 56);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -36;
sun.shadow.camera.right = 36;
sun.shadow.camera.top = 36;
sun.shadow.camera.bottom = -36;
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 180;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.035;
scene.add(sun);
scene.add(sun.target);

const fill = new THREE.DirectionalLight(PAL.fill, 1.08);
fill.position.set(48, 26, -44);
scene.add(fill);
const bounce = new THREE.DirectionalLight(0xd8cbe8, 0.34);
bounce.position.set(10, -18, 40);
scene.add(bounce);
scene.add(new THREE.HemisphereLight(PAL.hemiSky, PAL.hemiGround, 1.12));

buildSky(scene, 320);

let world = buildWorld(scene);
let roomStartedAt = null;
let displayName = '';
let playerCount = 1;
let phase = 'menu'; // menu | lobby | playing | spectate | roundEnd
let lobbyReady = false;
let onlineMode = false;

const controls = createControls(canvas);
const player = new Player(camera, canvas, world, controls, {
  x: -18, z: 0.2, yaw: -Math.PI / 2, pitch: 0.38,
});
const hud = createHud();
hud.setMobile(controls.mobile);
controls.setVisible(false);

const bgm = createBgm();
hud.setMuted(bgm.muted);
hud.onMuteToggle = () => {
  const muted = bgm.toggleMute();
  hud.setMuted(muted);
};
bgm.onChange(({ muted }) => hud.setMuted(muted));
window.addEventListener('pointerdown', () => bgm.unlock(), { passive: true });
window.addEventListener('keydown', () => bgm.unlock());

const remotes = createRemoteManager(scene, camera);
remotes.setLocalRoot(player.character.root);

const SPECTATE_HEIGHT = 78;
const SPECTATE_LOOK = new THREE.Vector3(0, 0, 0);
let spectateT = 0;

function enterSpectate() {
  phase = 'spectate';
  player.playing = false;
  controls.unlock();
  controls.setVisible(false);
  hud.showSpectate();
  hud.setHint('Spectating survivors · round ends when none remain');
  if (player.character?.root) player.character.root.visible = false;
}

function applySpectateCamera(dt) {
  spectateT += dt;
  const bob = Math.sin(spectateT * 0.35) * 2;
  camera.position.set(4 + bob * 0.2, SPECTATE_HEIGHT, 10);
  camera.up.set(0, 0, -1);
  camera.lookAt(SPECTATE_LOOK.x, 0, SPECTATE_LOOK.z);
}

const net = createNetClient({
  onWelcome(msg) {
    welcomed = true;
    if (joinTimeout) clearTimeout(joinTimeout);
    onlineMode = true;
    playerCount = 1 + (msg.players?.length || 0);
    hud.setNetStatus(`Connected · ${msg.phase || 'lobby'}`);
    remotes.clear();
    remotes.add({
      id: msg.id, name: displayName,
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
    }, { isSelf: true });
    for (const p of msg.players || []) remotes.add(p);

    if (msg.phase === 'playing') {
      // Late join mid-round → spectate
      roomStartedAt = msg.startedAt;
      beginPlay({ online: true, spectate: true });
    } else {
      phase = 'lobby';
      lobbyReady = false;
      hud.showLobby();
      if (msg.lobby) applyLobby(msg.lobby);
    }
  },
  onFull(message) {
    welcomed = true;
    if (joinTimeout) clearTimeout(joinTimeout);
    hud.setNetStatus('');
    hud.showFull(message);
  },
  onLobby(lobby) {
    if (phase === 'playing' || phase === 'spectate') return;
    phase = 'lobby';
    applyLobby(lobby);
    hud.showLobby();
  },
  onRoundStart(msg) {
    roomStartedAt = msg.startedAt;
    playerCount = (msg.players?.length) || playerCount;
    remotes.clear();
    for (const p of msg.players || []) {
      if (p.id === net.id) {
        remotes.add({ ...p, name: displayName }, { isSelf: true });
      } else {
        remotes.add(p);
      }
    }
    beginPlay({ online: true, spectate: !!msg.spectate });
  },
  onRoundEnd(msg) {
    phase = 'roundEnd';
    running = false;
    player.playing = false;
    controls.unlock();
    controls.setVisible(false);
    hud.hideSpectate();
    if (score > best) {
      best = Math.floor(score);
      try { localStorage.setItem(HS_KEY, String(best)); } catch { /* */ }
    }
    hud.showRoundEnd({ scores: msg.scores || [], best });
  },
  onJoin(p) {
    if (p.id === net.id) return; // never spawn a second body/name for self
    remotes.add(p);
    playerCount = Math.min(30, playerCount + 1);
    hud.flash(`${p.name} joined`);
  },
  onLeave(id) {
    remotes.remove(id);
    playerCount = Math.max(1, playerCount - 1);
  },
  onStates(list) {
    remotes.applyStates(list, net.id);
    playerCount = list.length || playerCount;
    // Hide dead remotes' bodies but keep nametags for living only
    for (const p of list) {
      if (p.id === net.id) continue;
      const r = remotes.remotes.get(p.id);
      if (!r?.char) continue;
      const living = p.alive !== false && (p.lives == null || p.lives > 0);
      r.char.root.visible = living || phase === 'spectate';
      if (r.label) r.label.element.style.opacity = living ? '1' : '0.35';
    }
  },
  onClose() {
    if (running || phase === 'spectate') hud.flash('Disconnected from server');
  },
  onError(err) {
    hud.setNetStatus(err.message || 'Connection failed — start with npm run server');
  },
});

function applyLobby(lobby) {
  const me = (lobby.players || []).find((p) => p.id === net.id);
  lobbyReady = !!me?.ready;
  hud.updateLobby({
    filled: lobby.filled,
    max: lobby.max || 30,
    endsAt: lobby.endsAt,
    serverNow: lobby.serverNow,
    mode: lobby.mode,
    players: lobby.players,
    myId: net.id,
    ready: lobbyReady,
  });
}

let welcomed = false;
let joinTimeout = null;
let running = false;
let survived = 0;
let score = 0;
let deathReason = '';
let best = 0;
let lightPulse = 0;
try { best = Number(localStorage.getItem(HS_KEY)) || 0; } catch { /* */ }

function wireWorld(w) {
  w.onQuake = (amt) => {
    if (phase === 'spectate') return;
    player.addShake(amt);
    lightPulse = Math.max(lightPulse, amt);
  };
  w.onFlash = (msg) => hud.flash(msg);
}
wireWorld(world);

player.onDeath = (reason) => {
  deathReason = reason;
  if (onlineMode) {
    // Mid-round: no retry — spectate
    enterSpectate();
    net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      facing: player.facing, yaw: player.yaw,
      moving: 0, run: false, alive: false, lives: 0,
      score, survived,
    }, 1);
  } else {
    endRunSolo();
  }
};
player.onHurt = (reason, livesLeft) => {
  hud.pulseHurt();
  hud.flash(livesLeft === 1 ? 'Last life!' : `${livesLeft} lives left`);
  hud.update({
    energy: player.energy, time: survived, score,
    players: playerCount, lives: player.lives,
  });
};

function beginPlay({ online = false, spectate = false } = {}) {
  onlineMode = online;
  // Fresh map each round (online + offline)
  if (world?.root) scene.remove(world.root);
  world = buildWorld(scene);
  player.world = world;
  wireWorld(world);
  if (!online) roomStartedAt = Date.now();
  // Online uses server startedAt already set from roundStart
  player.reset();
  deathReason = '';
  lightPulse = 0;
  survived = 0;
  score = 0;
  lobbyReady = false;
  hud.hideLobby();

  if (spectate) {
    player.alive = false;
    player.lives = 0;
    running = true;
    enterSpectate();
    bgm.start();
    return;
  }

  player.playing = true;
  player.alive = true;
  running = true;
  phase = 'playing';
  hud.showPlaying();
  hud.hideSpectate();
  if (player.character?.root) player.character.root.visible = true;
  controls.setVisible(true);
  controls.lock();
  bgm.start();
  hud.setHint(controls.mobile
    ? '<b>Stick</b> walk (recharges) · <b>RUN</b> drains · drag orbit'
    : '<b>WASD</b> walk recharges · <b>Shift</b> run drains · mouse orbit');
}

function startRun(name) {
  displayName = name;
  phase = 'menu';
  welcomed = false;
  lobbyReady = false;
  hud.setNetStatus('Connecting…');
  if (joinTimeout) clearTimeout(joinTimeout);
  joinTimeout = setTimeout(() => {
    if (welcomed || running) return;
    hud.setNetStatus('No server — playing solo offline');
    hud.flash('Solo offline (run npm run server for multiplayer)');
    onlineMode = false;
    beginPlay({ online: false });
  }, 2500);
  net.connect(name);
}

function endRunSolo() {
  running = false;
  phase = 'menu';
  player.playing = false;
  controls.unlock();
  controls.setVisible(false);
  if (score > best) {
    best = Math.floor(score);
    try { localStorage.setItem(HS_KEY, String(best)); } catch { /* */ }
  }
  hud.showDead({
    reason: deathReason || 'dead',
    time: survived,
    score,
    best,
  });
}

hud.onStart = (name) => startRun(name);
hud.onReady = () => {
  lobbyReady = true;
  net.sendReady();
  hud.flash('Ready!');
};
hud.showStart();

canvas.addEventListener('click', () => {
  if (phase === 'playing' && running && !controls.mobile && !player.locked) controls.lock();
});

const pipeline = new Pipeline(renderer, scene, camera);

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  pipeline.setSize(w, h);
  setOutlineResolution(pipeline.size.x, pipeline.size.y);
  remotes.resize(w, h);
  splatCanvas.width = w;
  splatCanvas.height = h;
  pinoc?.resize();
}
window.addEventListener('resize', resize);
resize();

/** Swap procedural local avatar for Pinoc .vsplat once the splat layer is ready. */
async function bootPinoc() {
  if (!splatCanvas) {
    console.warn('[Aftershock] #splat-view missing — Pinoc disabled');
    return;
  }
  try {
    pinoc = await initPinocLayer(splatCanvas);
    const avatar = await pinoc.createAvatar({
      lod: controls.mobile ? 'performance' : 'high',
    });
    const old = player.character;
    if (player.footRing) avatar.root.add(player.footRing);
    const parent = old.root.parent || scene;
    parent.remove(old.root);
    parent.add(avatar.root);
    player.character = avatar;
    remotes.setLocalRoot(avatar.root);
    remotes.setPinocFactory((opts) => pinoc.createAvatar(opts));
    pinoc.syncCamera(camera);
    console.info('[Aftershock] Pinoc splat avatar ready');
  } catch (err) {
    console.warn('[Aftershock] Pinoc avatar failed; keeping procedural human', err);
    window.__aftershockPinoc = { ready: false, error: String(err?.message || err) };
  }
}
bootPinoc();

window.addEventListener('keydown', (e) => {
  if (e.code === 'KeyO') pipeline.enabled.ink = !pipeline.enabled.ink;
  if (e.code === 'KeyG') pipeline.enabled.grade = !pipeline.enabled.grade;
});

const clock = new THREE.Clock();
const baseSun = 2.25;
const baseFill = 1.08;

console.info(`[Aftershock] seed=${WORLD_SEED} mobile=${controls.mobile}`);

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());

  if (roomStartedAt && (phase === 'playing' || phase === 'spectate')) {
    world.roomElapsed = (Date.now() - roomStartedAt) / 1000;
  }

  if (lightPulse > 0) {
    lightPulse = Math.max(0, lightPulse - dt * 1.6);
    const flicker = 1 + Math.sin(performance.now() * 0.055) * lightPulse * 0.35;
    sun.intensity = baseSun * flicker;
    fill.intensity = baseFill * (1 - lightPulse * 0.25);
  } else {
    sun.intensity = baseSun;
    fill.intensity = baseFill;
  }

  if (phase === 'playing' && running && player.alive) {
    survived += dt;
    const speed = Math.hypot(player.vel.x, player.vel.z);
    score = survived * 10 + speed * dt * 2;
    for (const u of world.updaters) u(dt, player);
    player.update(dt);
    hud.update({
      energy: player.energy, time: survived, score,
      players: playerCount, lives: player.lives,
    });

    net.sendState({
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      facing: player.facing,
      yaw: player.yaw,
      moving: speed,
      run: speed > player.walkSpeed * 1.2,
      alive: player.alive,
      lives: player.lives,
      score,
      survived,
    }, dt);

    remotes.setSelfPose(net.id, displayName, player.pos, player.facing);

    sun.target.position.set(player.pos.x, 0, player.pos.z);
    sun.position.set(player.pos.x - 52, 62, player.pos.z + 56);
    sun.target.updateMatrixWorld();
  } else if (phase === 'spectate') {
    // Keep hazards advancing for everyone; spectator doesn't control
    for (const u of world.updaters) u(dt, player);
    applySpectateCamera(dt);
    hud.update({
      energy: 0, time: survived, score,
      players: playerCount, lives: 0,
    });
    net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      facing: player.facing, yaw: player.yaw,
      moving: 0, run: false, alive: false, lives: 0,
      score, survived,
    }, dt);
    sun.target.position.set(0, 0, 0);
    sun.position.set(-52, 90, 56);
    sun.target.updateMatrixWorld();
  } else if (running && !player.alive) {
    net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      facing: player.facing, yaw: player.yaw, moving: 0, run: false, alive: false, lives: 0,
    }, dt);
    player.update(dt);
  } else {
    player.update(dt);
  }

  remotes.tick(dt);

  if (player.hitFlash > 0.01 && phase === 'playing') {
    document.body.style.boxShadow = `inset 0 0 ${80 * player.hitFlash}px rgba(200,40,30,${0.45 * player.hitFlash})`;
  } else {
    document.body.style.boxShadow = '';
  }

  pipeline.render();
  pinoc?.syncCamera(camera);
  remotes.render();
}
frame();
