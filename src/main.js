import * as THREE from 'three';
import { PAL } from './core/palette.js';
import { Pipeline } from './core/post.js';
import { buildSky } from './core/sky.js';
import { setOutlineResolution } from './core/outline.js';
import { Player } from './core/player.js';
import { createHud } from './core/hud.js';
import { createControls } from './core/controls.js';
import { buildWorld, WORLD_SEED } from './world/index.js';
import { spawnPoints } from './world/street.js';
import { createNetClient } from './net/client.js';
import { createRemoteManager } from './net/remotes.js';
import { createBgm } from './core/bgm.js';
import { initPinocLayer } from './world/pinocLayer.js';
import { createMinimap } from './core/minimap.js';
import { createSfx } from './core/sfx.js';
import { createCharacter } from './world/character.js';

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
let roomSeed = WORLD_SEED;
/** Solo-round cap (server ms clock) — null for versus rounds. */
let roundEndsAt = null;
let roundMode = 'versus';
let lastShindoSeen = 0;
let aliveSince = performance.now();
/** serverNow − Date.now(), best (lowest-latency) estimate. */
let clockOffset = null;
const SPAWNS = spawnPoints();
let displayName = '';
let playerCount = 1;
let phase = 'menu'; // menu | lobby | playing | spectate | roundEnd
let lobbyReady = false;
let onlineMode = false;

const controls = createControls(canvas);
const player = new Player(camera, canvas, world, controls, {
  x: SPAWNS[0].x, z: SPAWNS[0].z, yaw: SPAWNS[0].yaw, pitch: 0.38,
});
const hud = createHud();
const minimap = createMinimap();
const hurtFlash = document.createElement('div');
hurtFlash.className = 'hurt-flash';
document.body.appendChild(hurtFlash);
hud.setMobile(controls.mobile);
controls.setVisible(false);

const bgm = createBgm();
hud.setMuted(bgm.muted);
hud.onMuteToggle = () => {
  const muted = bgm.toggleMute();
  hud.setMuted(muted);
};
const sfx = createSfx();
sfx.setMuted(bgm.muted);
bgm.onChange(({ muted }) => {
  hud.setMuted(muted);
  sfx.setMuted(muted);
});
window.addEventListener('pointerdown', () => { bgm.unlock(); sfx.unlock(); }, { passive: true });
window.addEventListener('keydown', () => { bgm.unlock(); sfx.unlock(); });

const remotes = createRemoteManager(scene, camera);
remotes.setLocalRoot(player.character.root);

/* ---------------- after you lose: birdview / follow ---------------- *
 * Death pulls the camera up from your body into a birdview of the whole
 * town with a marker pillar over every survivor. Click / tap cycles:
 * birdview → follow survivor 1 → … → birdview.
 */
const BIRD_POS = new THREE.Vector3(0, 108, 64);
const BIRD_LOOK = new THREE.Vector3(0, 0, 5);
const BIRD_RISE = 2.6;
let spectateT = 0;
let spectateId = null; // null = birdview
let birdT = 0;
let soloSpectate = false;
let soloDeadShownAt = 0;
const _birdFrom = new THREE.Vector3();
const _birdFromLook = new THREE.Vector3();
const _specPos = new THREE.Vector3();
const _specLook = new THREE.Vector3();
const _look = new THREE.Vector3();

const markers = new Map();
const markerGeo = {
  ring: new THREE.RingGeometry(1.0, 1.6, 32).rotateX(-Math.PI / 2),
  pillar: new THREE.CylinderGeometry(0.22, 0.22, 7, 8).translate(0, 3.5, 0),
  head: new THREE.ConeGeometry(0.9, 1.6, 12).rotateX(Math.PI).translate(0, 8.2, 0),
};
const markerMat = new THREE.MeshBasicMaterial({ color: 0x3d8cf0, fog: false, transparent: true, opacity: 0.9, depthWrite: false });
const markerSelfMat = new THREE.MeshBasicMaterial({ color: 0xef8a3c, fog: false, transparent: true, opacity: 0.9, depthWrite: false });

function markerFor(id) {
  let m = markers.get(id);
  if (!m) {
    m = new THREE.Group();
    for (const g of Object.values(markerGeo)) {
      const mesh = new THREE.Mesh(g, markerMat);
      mesh.renderOrder = 6;
      m.add(mesh);
    }
    scene.add(m);
    markers.set(id, m);
  }
  return m;
}

function updateMarkers(show, scale) {
  const seen = new Set();
  if (show) {
    for (const [id, r] of livingRemotes()) {
      const m = markerFor(id);
      m.position.copy(r.char.root.position);
      m.scale.setScalar(scale);
      m.visible = true;
      seen.add(id);
    }
  }
  for (const [id, m] of markers) {
    if (seen.has(id)) continue;
    m.visible = false;
  }
}

function setBirdShadows(on) {
  const c = sun.shadow.camera;
  const e = on ? 66 : 36;
  if (c.right === e) return;
  c.left = -e; c.right = e; c.top = e; c.bottom = -e;
  c.updateProjectionMatrix();
}

function enterSpectate({ solo = false, banner } = {}) {
  phase = 'spectate';
  soloSpectate = solo;
  soloDeadShownAt = 0;
  player.playing = false;
  controls.unlock();
  controls.setVisible(false);
  if (!solo) hud.showSpectate(banner);
  spectateId = null;
  spectateT = 0;
  birdT = 0;
  _birdFrom.copy(camera.position);
  _birdFromLook.set(player.pos.x, player.pos.y + 1, player.pos.z);
  if (player.character?.root) player.character.root.visible = false;
}

function livingRemotes() {
  const out = [];
  for (const [id, r] of remotes.remotes) {
    if (r.isSelf || !r.char?.root) continue;
    if (r.target?.alive === false || (r.target?.lives != null && r.target.lives <= 0)) continue;
    out.push([id, r]);
  }
  return out;
}

function cycleSpectate() {
  const living = livingRemotes();
  if (!living.length) { spectateId = null; return; }
  if (spectateId == null) {
    spectateId = living[0][0];
    return;
  }
  const i = living.findIndex(([id]) => id === spectateId);
  spectateId = i < 0 || i + 1 >= living.length ? null : living[i + 1][0];
  if (spectateId == null) {
    // back to birdview: rise from wherever the camera is now
    birdT = 0;
    _birdFrom.copy(camera.position);
    camera.getWorldDirection(_look);
    _birdFromLook.copy(camera.position).addScaledVector(_look, 10);
  }
}

const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function applySpectateCamera(dt) {
  spectateT += dt;
  let r = spectateId ? remotes.remotes.get(spectateId) : null;
  const followAlive = r && r.target?.alive !== false && (r.target?.lives == null || r.target.lives > 0);
  if (spectateId && !followAlive) {
    spectateId = null;
    r = null;
    birdT = 0;
    _birdFrom.copy(camera.position);
    _birdFromLook.copy(camera.position).add(new THREE.Vector3(0, -5, -5));
  }
  const nLiving = livingRemotes().length;

  if (r?.char?.root) {
    const p = r.char.root.position;
    const a = spectateT * 0.18;
    _specPos.set(p.x + Math.sin(a) * 9, p.y + 8.5, p.z + Math.cos(a) * 9);
    _specLook.set(p.x, p.y + 1, p.z);
    camera.position.lerp(_specPos, 1 - Math.exp(-4 * dt));
    camera.up.set(0, 1, 0);
    camera.lookAt(_specLook);
    scene.fog.near = 32;
    scene.fog.far = 110;
    setBirdShadows(false);
    sun.target.position.set(p.x, 0, p.z);
    sun.position.set(p.x - 52, 62, p.z + 56);
    updateMarkers(false, 1);
    hud.setHint(`Following <b>${r.name || 'survivor'}</b> · click / tap: next / birdview`);
    return;
  }

  // Birdview: rise from the body, then hold with a slow drift
  // wall-clock so the pull-up takes the same time even on slow frames
  const now = performance.now() / 1000;
  birdT = Math.min(BIRD_RISE, birdT + Math.min(0.25, now - (applySpectateCamera.last ?? now)));
  applySpectateCamera.last = now;
  const e = ease(birdT / BIRD_RISE);
  const drift = Math.sin(spectateT * 0.12) * 6;
  _specPos.set(BIRD_POS.x + drift, BIRD_POS.y, BIRD_POS.z);
  camera.position.lerpVectors(_birdFrom, _specPos, e);
  // rise faster than travel so it reads as "pulling up" off the body
  camera.position.y = THREE.MathUtils.lerp(_birdFrom.y, _specPos.y, Math.min(1, e * 1.35));
  _look.lerpVectors(_birdFromLook, BIRD_LOOK, e);
  camera.up.set(0, 1, 0);
  camera.lookAt(_look);
  scene.fog.near = THREE.MathUtils.lerp(32, 230, e);
  scene.fog.far = THREE.MathUtils.lerp(110, 420, e);
  setBirdShadows(e > 0.5);
  sun.target.position.set(0, 0, 0);
  sun.position.set(-52, 90, 56);
  updateMarkers(e > 0.15, 0.6 + e * 1.4);
  hud.setHint(nLiving
    ? `Birdview · <b>${nLiving}</b> survivor${nLiving > 1 ? 's' : ''} · click / tap to follow one`
    : 'Birdview · watching the town shake');
}

/** Menu / lobby / results backdrop: slow aerial orbit of the town. */
let menuOrbit = 0.6;
function applyMenuCamera(dt) {
  menuOrbit += dt * 0.045;
  camera.position.set(Math.cos(menuOrbit) * 74, 48, Math.sin(menuOrbit) * 74);
  camera.up.set(0, 1, 0);
  camera.lookAt(0, 0, 0);
  scene.fog.near = 70;
  scene.fog.far = 230;
  setBirdShadows(true);
  sun.target.position.set(0, 0, 0);
  sun.position.set(-52, 90, 56);
  sun.target.updateMatrixWorld();
  if (player.character?.root) player.character.root.visible = false;
  if (phase !== 'menu') hud.setHint('');
}

function restoreFog() {
  scene.fog.near = 32;
  scene.fog.far = 110;
  setBirdShadows(false);
  updateMarkers(false, 1);
}

function noteServerTime(serverNow) {
  if (typeof serverNow !== 'number') return;
  const est = serverNow - Date.now();
  // Latency only ever makes the estimate smaller, so keep the max; let it
  // decay slowly so a clock step on either side still converges.
  clockOffset = clockOffset == null ? est : Math.max(est, clockOffset - 5);
}

function serverNowMs() {
  return Date.now() + (clockOffset ?? 0);
}

function slotSpawn(idx) {
  const sp = SPAWNS[((idx % SPAWNS.length) + SPAWNS.length) % SPAWNS.length];
  return sp;
}

const net = createNetClient({
  onWelcome(msg) {
    welcomed = true;
    clockOffset = null;
    noteServerTime(msg.serverNow ?? msg.lobby?.serverNow);
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
      // Late join mid-round → spectate (server follows up with roundStart)
      roomStartedAt = msg.startedAt;
      if (msg.seed != null) roomSeed = msg.seed;
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
    noteServerTime(lobby.serverNow);
    if (phase === 'playing' || phase === 'spectate') return;
    lastLobby = lobby;
    if (hud.resultsOpen) {
      // Leaderboard stays until "Play again"; just tick the countdown under it
      updateResultsCountdown();
      return;
    }
    phase = 'lobby';
    applyLobby(lobby);
    hud.showLobby();
    if (wantReadyOnLobby && !lobbyReady) {
      wantReadyOnLobby = false;
      hud.onReadyFire?.();
    }
  },
  onRoundStart(msg) {
    noteServerTime(msg.serverNow);
    roomStartedAt = msg.startedAt;
    roundEndsAt = msg.endsAt || null;
    roundMode = msg.mode || 'versus';
    if (msg.seed != null) roomSeed = msg.seed;
    playerCount = (msg.players?.length) || playerCount;
    remotes.clear();
    (msg.players || []).forEach((p, i) => {
      const slot = p.slot ?? i;
      if (p.id === net.id) {
        const sp = slotSpawn(slot);
        player.setSpawn(sp.x, sp.z, sp.yaw);
      } else if (!msg.spectate) {
        const sp = slotSpawn(slot);
        p.x = sp.x;
        p.z = sp.z;
      }
    });
    for (const p of msg.players || []) {
      if (p.id === net.id) {
        remotes.add({ ...p, name: displayName, gender: localGender }, { isSelf: true });
      } else {
        remotes.add(p);
      }
    }
    beginPlay({ online: true, spectate: !!msg.spectate });
  },
  onRoundEnd(msg) {
    phase = 'roundEnd';
    restoreFog();
    running = false;
    player.playing = false;
    controls.unlock();
    controls.setVisible(false);
    hud.hideSpectate();
    if (score > best) {
      best = Math.floor(score);
      try { localStorage.setItem(HS_KEY, String(best)); } catch { /* */ }
    }
    roundEndsAt = null;
    hud.setRoundTimer(null);
    hud.showRoundEnd({
      scores: msg.scores || [], best, myId: net.id,
      reason: msg.reason, winnerId: msg.winnerId, mode: msg.mode,
    });
    hud.setHint('');
    remotes.clear(); // re-added on the next roundStart; no stray nametags over the menu
    updateMarkers(false, 1);
    lastLobby = null;
    updateResultsCountdown();
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
  onStates(list, msg) {
    noteServerTime(msg?.serverNow);
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

let lastLobby = null;
let wantReadyOnLobby = false;

function updateResultsCountdown() {
  if (!lastLobby || lastLobby.phase && lastLobby.phase !== 'lobby') {
    hud.setResultsCountdown('Next lobby opening…');
    return;
  }
  const now = serverNowMs();
  const left = Math.max(0, Math.ceil((lastLobby.endsAt - now) / 1000));
  hud.setResultsCountdown(`Next round starts in ${left}s`);
}
setInterval(() => { if (hud.resultsOpen && onlineMode) updateResultsCountdown(); }, 250);

function readyUp() {
  lobbyReady = true;
  net.sendReady();
  hud.flash('Ready!');
}

hud.onPlayAgain = () => {
  hud.hideResults();
  if (lastLobby && (!lastLobby.phase || lastLobby.phase === 'lobby')) {
    phase = 'lobby';
    applyLobby(lastLobby);
    hud.showLobby();
    readyUp();
  } else {
    // lobby not reopened yet — ready up the moment it does
    wantReadyOnLobby = true;
    hud.showLobby();
  }
};

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
  w.onSfx = (name, x, z, vol) => sfx.play(name, x, z, vol);
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
    // Solo: same pull-up birdview, then the results card over it
    enterSpectate({ solo: true });
    soloDeadShownAt = performance.now() + (BIRD_RISE + 0.8) * 1000;
  }
};
player.onJump = () => sfx.play('whoosh', null, null, 0.35);
player.onLand = () => sfx.play('hurt', null, null, 0.18);
player.onFall = () => {
  sfx.play('fall');
  player.hitFlash = 1;
};
player.onHurt = (reason, livesLeft) => {
  sfx.play('hurt');
  hud.pulseHurt();
  hud.flash(livesLeft === 1 ? 'Last life!' : `${livesLeft} lives left`);
  hud.update({
    energy: player.energy, time: survived, score,
    players: playerCount, lives: player.lives,
  });
};

function beginPlay({ online = false, spectate = false } = {}) {
  onlineMode = online;
  // Fresh map each round (online + offline); hazards follow the room seed
  if (world?.root) {
    world.disaster?.reset();
    scene.remove(world.root);
  }
  if (!online) {
    roomSeed = (WORLD_SEED + Math.floor(Math.random() * 100000)) >>> 0;
    roomStartedAt = Date.now();
    roundEndsAt = roomStartedAt + 10 * 60_000;
    roundMode = 'solo';
    clockOffset = 0;
    const sp = slotSpawn(Math.floor(Math.random() * SPAWNS.length));
    player.setSpawn(sp.x, sp.z, sp.yaw);
  }
  soloSpectate = false;
  soloDeadShownAt = 0;
  lastShindoSeen = 0;
  hud.hideResults();
  world = buildWorld(scene, { seed: roomSeed });
  player.world = world;
  wireWorld(world);
  restoreFog();
  // Online uses server startedAt already set from roundStart
  player.reset();
  deathReason = '';
  lightPulse = 0;
  survived = 0;
  aliveSince = performance.now();
  score = 0;
  lobbyReady = false;
  hud.hideLobby();

  if (spectate) {
    player.alive = false;
    player.lives = 0;
    running = true;
    enterSpectate({ banner: '<strong>Round in progress</strong> · observing — you join the next round' });
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

function startRun(name, gender = localGender) {
  displayName = name;
  if (gender !== localGender || (player.character?.gender && player.character.gender !== gender)) setLocalAvatar(gender);
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
  net.connect(name, gender);
}

/** Solo results card, shown over the birdview (world keeps shaking behind it). */
function showSoloResults() {
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

hud.onStart = (name, gender) => {
  // Join click is a user gesture — go full screen right away
  hud.requestFullscreen();
  startRun(name, gender);
};
hud.onReady = () => readyUp();
hud.onReadyFire = () => readyUp();
hud.showStart();

canvas.addEventListener('click', () => {
  if (phase === 'playing' && running && !controls.mobile && !player.locked) controls.lock();
});
// Spectators cycle survivors with a click / tap anywhere on the view
window.addEventListener('pointerdown', (e) => {
  if (phase === 'spectate' && !soloSpectate && e.target === canvas) cycleSpectate();
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
let localGender = (() => { try { return localStorage.getItem('aftershock-gender') === 'f' ? 'f' : 'm'; } catch { return 'm'; } })();
let avatarSeq = 0;

function swapLocalAvatar(avatar) {
  const old = player.character;
  if (player.footRing) avatar.root.add(player.footRing);
  const parent = old.root.parent || scene;
  parent.remove(old.root);
  old.destroy?.();
  parent.add(avatar.root);
  avatar.root.visible = old.root.visible;
  player.character = avatar;
  remotes.setLocalRoot(avatar.root);
}

/** Local body for the chosen character: Pinoc splat when available, else procedural. */
async function setLocalAvatar(gender) {
  const seq = ++avatarSeq;
  localGender = gender;
  if (pinoc && (gender === 'm' || pinoc.hasFemale)) {
    try {
      const avatar = await pinoc.createAvatar({ lod: controls.mobile ? 'performance' : 'high', gender });
      if (seq !== avatarSeq) { avatar.destroy?.(); return; }
      swapLocalAvatar(avatar);
      return;
    } catch (err) {
      console.warn('[Aftershock] Pinoc avatar failed; procedural body', err);
    }
  }
  if (seq !== avatarSeq) return;
  if (player.character?.gender === gender && !player.character.pinoc) return;
  const body = createCharacter({ gender });
  body.gender = gender;
  swapLocalAvatar(body);
}

/** Boot the Pinoc splat layer, then dress the local player. */
async function bootPinoc() {
  if (!splatCanvas) {
    console.warn('[Aftershock] #splat-view missing — Pinoc disabled');
    return;
  }
  try {
    pinoc = await initPinocLayer(splatCanvas);
    remotes.setPinocFactory((opts) => pinoc.createAvatar(opts));
    pinoc.syncCamera(camera);
    console.info('[Aftershock] Pinoc splat layer ready', { female: pinoc.hasFemale, jump: pinoc.hasJump });
  } catch (err) {
    console.warn('[Aftershock] Pinoc layer failed; keeping procedural humans', err);
    window.__aftershockPinoc = { ready: false, error: String(err?.message || err) };
  }
  await setLocalAvatar(localGender);
}
bootPinoc();

window.addEventListener('keydown', (e) => {
  if (/^(INPUT|TEXTAREA)$/.test(e.target?.tagName)) return;
  if (e.code === 'KeyO') pipeline.enabled.ink = !pipeline.enabled.ink;
  if (e.code === 'KeyG') pipeline.enabled.grade = !pipeline.enabled.grade;
});

const clock = new THREE.Clock();
const baseSun = 2.25;
const baseFill = 1.08;

console.info(`[Aftershock] seed=${WORLD_SEED} mobile=${controls.mobile}`);

// Debug / screenshot harness handle
window.__aftershock = {
  player, camera, scene, renderer, pipeline,
  get world() { return world; },
  get phase() { return phase; },
};

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());

  world.viewPos = camera.position;
  if (roomStartedAt && (phase === 'playing' || phase === 'spectate')) {
    world.roomElapsed = Math.max(0, (serverNowMs() - roomStartedAt) / 1000);
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
    // wall clock, not summed frame dt (dt is capped, so slow devices undercounted)
    survived = (performance.now() - aliveSince) / 1000;
    const speed = Math.hypot(player.vel.x, player.vel.z);
    score = survived * 10 + speed * dt * 2;
    for (const u of world.updaters) u(dt, player);
    // Intensity steps up → tell the player
    const sh = world.disaster?.shindo || 1;
    if (sh > lastShindoSeen) {
      if (lastShindoSeen) hud.flash(`Quake intensifying — 震度 ${sh}`);
      lastShindoSeen = sh;
    }
    // Offline solo: outlast the 10-minute cap and you win
    if (!onlineMode && roundEndsAt && Date.now() >= roundEndsAt && player.alive) {
      deathReason = 'survived';
      roundEndsAt = null;
      enterSpectate({ solo: true });
      soloDeadShownAt = performance.now() + (BIRD_RISE + 0.8) * 1000;
    }
    // Other living players are solid
    player.others.length = 0;
    for (const [, r] of livingRemotes()) player.others.push(r.char.root.position);
    player.update(dt);
    hud.update({
      energy: player.energy, time: survived, score,
      players: playerCount, lives: player.lives, exhausted: player.exhausted,
      shindo: world.disaster?.shindo,
    });

    net.sendState({
      x: player.pos.x,
      y: player.pos.y,
      z: player.pos.z,
      facing: player.facing,
      yaw: player.yaw,
      moving: speed,
      run: speed > player.walkSpeed * 1.2,
      air: player.airborne,
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
    player.hitFlash = Math.max(0, player.hitFlash - dt * 0.4);
    applySpectateCamera(dt);
    hud.update({
      energy: 0, time: survived, score,
      players: playerCount, lives: 0, shindo: world.disaster?.shindo,
    });
    net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      facing: player.facing, yaw: player.yaw,
      moving: 0, run: false, alive: false, lives: 0,
      score, survived,
    }, dt);
    sun.target.updateMatrixWorld();
    if (soloSpectate && soloDeadShownAt && performance.now() > soloDeadShownAt) {
      soloDeadShownAt = 0;
      showSoloResults();
    }
  } else if (running && !player.alive) {
    net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      facing: player.facing, yaw: player.yaw, moving: 0, run: false, alive: false, lives: 0,
    }, dt);
    player.update(dt);
  } else {
    player.update(dt);
    applyMenuCamera(dt);
  }

  remotes.tick(dt);
  hud.setRoundTimer(roundEndsAt && (phase === 'playing' || phase === 'spectate')
    ? (roundEndsAt - (onlineMode ? serverNowMs() : Date.now())) / 1000
    : null);

  // Audio listener: your avatar while playing, the town centre in birdview
  camera.getWorldDirection(_look);
  const rlen = Math.hypot(_look.x, _look.z) || 1;
  if (phase === 'spectate' && spectateId == null) {
    sfx.setListener({ x: 0, z: 0, rx: -_look.z / rlen, rz: _look.x / rlen, range: 2.2 });
  } else {
    const at = phase === 'spectate' ? _specLook : player.pos;
    sfx.setListener({ x: at.x, z: at.z, rx: -_look.z / rlen, rz: _look.x / rlen, range: 1 });
  }
  sfx.setRumble(running ? lightPulse * 1.3 : 0, dt);
  minimap.setVisible(phase === 'playing' || phase === 'spectate');
  minimap.update(dt, {
    world,
    self: phase === 'playing' ? { x: player.pos.x, z: player.pos.z, facing: player.facing } : null,
    remotes,
    myId: net.id,
  });

  // Red hurt flash: snaps in, fades over ~2.5 s, with a short pulse
  const hf = phase === 'playing' || phase === 'spectate' ? player.hitFlash : 0;
  hurtFlash.style.opacity = hf > 0.01
    ? String(Math.min(1, hf * 1.1) * (0.85 + 0.15 * Math.sin(performance.now() * 0.012)))
    : '0';

  pipeline.render();
  pinoc?.syncCamera(camera);
  remotes.render();
}
frame();
