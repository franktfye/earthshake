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

const HS_KEY = 'aftershock-best';

const canvas = document.getElementById('view');

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
// Unlock audio on first pointer gesture (autoplay policy)
const unlockAudio = () => bgm.unlock();
window.addEventListener('pointerdown', unlockAudio, { passive: true });
window.addEventListener('keydown', unlockAudio);

const remotes = createRemoteManager(scene, camera);

const net = createNetClient({
  onWelcome(msg) {
    welcomed = true;
    if (joinTimeout) clearTimeout(joinTimeout);
    roomStartedAt = msg.startedAt;
    playerCount = 1 + (msg.players?.length || 0);
    hud.setNetStatus(`Connected · room seed ${msg.seed}`);
    remotes.clear();
    remotes.add({ id: msg.id, name: displayName, x: player.pos.x, y: player.pos.y, z: player.pos.z }, { isSelf: true });
    for (const p of msg.players || []) remotes.add(p);
    beginPlay({ online: true });
  },
  onFull(message) {
    welcomed = true;
    if (joinTimeout) clearTimeout(joinTimeout);
    hud.setNetStatus('');
    hud.showFull(message);
  },
  onJoin(p) {
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
  },
  onClose() {
    if (running) hud.flash('Disconnected from server');
  },
  onError(err) {
    hud.setNetStatus(err.message || 'Connection failed — start with npm run server');
  },
});

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
    player.addShake(amt);
    lightPulse = Math.max(lightPulse, amt);
  };
  w.onFlash = (msg) => hud.flash(msg);
}
wireWorld(world);

player.onDeath = (reason) => {
  deathReason = reason;
  endRun();
};
player.onHurt = (reason, livesLeft) => {
  hud.pulseHurt();
  hud.flash(livesLeft === 1 ? 'Last life!' : `${livesLeft} lives left`);
  hud.update({
    energy: player.energy, time: survived, score,
    players: playerCount, lives: player.lives,
  });
};

function beginPlay({ online = false } = {}) {
  // Online: keep world and catch up hazards via roomElapsed.
  // Offline solo: rebuild so a retry is a fresh quake.
  if (!online) {
    if (world?.root) scene.remove(world.root);
    world = buildWorld(scene);
    player.world = world;
    wireWorld(world);
    roomStartedAt = Date.now();
  }
  player.reset();
  player.playing = true;
  player.alive = true;
  running = true;
  survived = 0;
  score = 0;
  deathReason = '';
  lightPulse = 0;
  hud.showPlaying();
  controls.setVisible(true);
  controls.lock();
  bgm.start();
  hud.setHint(controls.mobile
    ? '<b>Stick</b> walk (recharges) · <b>RUN</b> drains · drag orbit'
    : '<b>WASD</b> walk recharges · <b>Shift</b> run drains · mouse orbit');
}

function startRun(name) {
  displayName = name;
  // Already in a room (death → retry): respawn without rejoining
  if (net.connected && net.id) {
    beginPlay({ online: true });
    return;
  }
  welcomed = false;
  hud.setNetStatus('Connecting…');
  if (joinTimeout) clearTimeout(joinTimeout);
  joinTimeout = setTimeout(() => {
    if (welcomed || running) return;
    hud.setNetStatus('No server — playing solo offline');
    hud.flash('Solo offline (run npm run server for multiplayer)');
    beginPlay({ online: false });
  }, 2500);
  net.connect(name);
}

function endRun() {
  running = false;
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
hud.showStart();

canvas.addEventListener('click', () => {
  if (running && !controls.mobile && !player.locked) controls.lock();
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
}
window.addEventListener('resize', resize);
resize();

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

  if (roomStartedAt) {
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

  if (running && player.alive) {
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
    }, dt);

    remotes.setSelfPose(net.id, displayName, player.pos, player.facing);

    sun.target.position.set(player.pos.x, 0, player.pos.z);
    sun.position.set(player.pos.x - 52, 62, player.pos.z + 56);
    sun.target.updateMatrixWorld();
  } else if (running && !player.alive) {
    // still sync dead pose so others see you down
    net.sendState({
      x: player.pos.x, y: player.pos.y, z: player.pos.z,
      facing: player.facing, yaw: player.yaw, moving: 0, run: false, alive: false,
    }, dt);
    player.update(dt);
  } else {
    player.update(dt);
  }

  remotes.tick(dt);

  if (player.hitFlash > 0.01) {
    document.body.style.boxShadow = `inset 0 0 ${80 * player.hitFlash}px rgba(200,40,30,${0.45 * player.hitFlash})`;
  } else {
    document.body.style.boxShadow = '';
  }

  pipeline.render();
  remotes.render();
}
frame();
