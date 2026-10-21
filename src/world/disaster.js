import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { rngKit, box, bake } from '../core/util.js';
import { makeRubble } from './buildings.js';
import { makeSedan, makeVan, makeKeiTruck } from './props.js';
import { MAP } from './street.js';
import { setHolePunches, clearHolePunches, MAX_HOLES } from './holePunch.js';
import {
  makeShape, pointAt, containsOffset, boundR, outlinePts,
} from './fissureShape.js';

/**
 * Hazard scheduler — deterministic from room seed + room elapsed time.
 *
 * The map is split into zones (plaza + 4 quadrants); each zone runs its own
 * seeded clock so hazard density matches the old single-cross map wherever a
 * player stands. Events are processed in global time order and every
 * placement decision is made against an *event-time* log (never against
 * frame-dependent live state), so a late joiner fast-forwarding minutes of
 * events reproduces exactly the same cracks and drops as everyone else.
 * Cosmetic randomness uses per-entity RNGs and never touches zone streams.
 *
 * Telegraphs (1 s): falling debris → growing ground shadow + closing target
 * ring; fissure → exact outline that will open + spreading hairline cracks.
 * Fissures stay open 60 s (shared room clock) then close. Fallen objects and
 * collapse rubble settle and stay solid for 35 s; their landing spots are
 * computed analytically at event time so every client agrees on them.
 */

const WARN_TELEGRAPH = 1.0;
const HOLE_LIFETIME = 60;
const HOLE_OPEN = 0.45;
const HOLE_CLOSE = 0.7;
const PIT_DEPTH = 6.5;
const FALL_HEIGHT = 14;
const FALL_SPEED = 22;
const ZONE_HOLE_CAP = 6;
/** Walkable area of the old single-cross map — hazard density reference. */
const REF_AREA = 1240;
const NOTIFY_RADIUS = 28;
const STALE = 1.2;
/** Fallen objects / settled rubble stay on the street (and stay solid) this long. */
const OBJECT_LIFE = 35;
/** Max objects lying in / falling onto one zone at once (keeps streets passable). */
const ZONE_OBJECT_CAP = 26;
const GRAVITY = 14;
/** Runaway car: honk + lane warning, then it tears down the street. */
const CAR_TELEGRAPH = 1.2;
const CAR_HALF_L = 1.8;
const CAR_HALF_W = 0.8;

function hash(a, b) {
  let h = (a ^ Math.imul(b + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

const FACE_DIR = { 'z+': [0, 1], 'z-': [0, -1], 'x+': [1, 0], 'x-': [-1, 0] };

export function createDisaster(world, opts = {}) {
  const seed = (opts.seed ?? 20241019) >>> 0;
  let elapsed = 0;
  let holeSeq = 0;
  let debugSeq = 100000;
  let dropSeq = 0;
  const debugRng = rngKit(hash(seed, 424242));

  const zones = world.zones.map((z, i) => ({
    ...z,
    idx: i,
    rng: rngKit(hash(seed, i + 1)),
    next: 5 + i * 0.55,
    index: 0,
    gapScale: Math.min(1.6, Math.max(0.55, REF_AREA / Math.max(1, z.area))),
  }));

  /** Event-time logs — the only state placement decisions may read. */
  const holeLog = []; // { x, z, r, t0, expiresAt, zone }
  const dropLog = []; // { x, z, t0, end }

  const fissures = []; // live fissure entities
  const drops = [];
  const debris = [];
  const fallingProps = [];
  const listener = { x: 0, z: 0, set: false };

  /* ---------------- materials (shared, created once per world) ---------- */
  const pitMat = cel({ color: 0xffffff, vertexColors: true, bands: 3, tint: 0x2a2236, side: THREE.DoubleSide });
  const floorMat = flat({ color: 0x120d0e });
  const deepRubbleMat = flat({ color: 0x2b2325 });
  const crustRoad = cel({ color: PAL.road, bands: 3, tint: 0x6a608f });
  const crustWalk = cel({ color: PAL.sidewalk, bands: 3, tint: 0x7d74a0 });
  const crackMat = new THREE.MeshBasicMaterial({
    color: 0x2b2533, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const rubbleMat = cel({ color: PAL.rubble, bands: 3, tint: 0x5a5048 });
  const decal = (color, opacity) => new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
    side: THREE.DoubleSide,
  });

  /* ---------------- helpers ---------------- */
  function difficulty(t) {
    return Math.min(1.6, t / 36);
  }

  function notify(x, z, msg, amt) {
    if (!listener.set) return;
    const dist = Math.hypot(x - listener.x, z - listener.z);
    if (msg && dist < NOTIFY_RADIUS) world.onFlash?.(msg);
    const k = Math.max(0, 1 - dist / 45);
    if (k > 0 && amt) world.onQuake?.(amt * k);
  }

  /** Positional sound cue (main.js attenuates by distance / pans). */
  function sfx(name, x, z, vol = 1) {
    world.onSfx?.(name, x, z, vol);
  }

  function sampleSpot(z) {
    if (!z.rects.length) return null;
    let r = z.rng.next() * z.area;
    let rect = z.rects[z.rects.length - 1];
    for (const c of z.rects) {
      r -= c.a;
      if (r <= 0) { rect = c; break; }
    }
    const x = z.rng.range(rect.x0, rect.x1);
    const zz = z.rng.range(rect.z0, rect.z1);
    if (!z.inRegion(x, zz)) return null;
    return { x, z: zz };
  }

  function activeHoles(t) {
    return holeLog.filter((h) => t >= h.t0 && t < h.expiresAt + HOLE_CLOSE);
  }

  function shapeFits(shape, x, z) {
    if (!world.isOpenGround(x, z, 0.2)) return false;
    for (let i = 0; i < 40; i++) {
      const p = pointAt(shape, (i / 40) * Math.PI * 2, 1.12);
      if (!world.isOpenGround(x + p.x, z + p.z, 0.15)) return false;
    }
    return true;
  }

  function surfaceMax(x, z, r) {
    let y = world.surfaceAt(x, z);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      y = Math.max(y, world.surfaceAt(x + Math.cos(a) * r, z + Math.sin(a) * r));
    }
    return y;
  }

  /* ---------------- scheduling ---------------- */
  function scheduleGap(z, t) {
    const d = difficulty(t);
    return (Math.max(1.35, 6.5 - d * 4.5) + z.rng.range(0, 1.6)) * z.gapScale;
  }

  function spawnFissure(z, t, kind) {
    const active = activeHoles(t);
    if (active.length >= MAX_HOLES) return false;
    if (active.filter((h) => h.zone === z.idx).length >= ZONE_HOLE_CAP) return false;
    for (let i = 0; i < 20; i++) {
      const p = sampleSpot(z);
      const shape = makeShape(z.rng, kind);
      if (!p) continue;
      const r = boundR(shape);
      if (active.some((h) => Math.hypot(h.x - p.x, h.z - p.z) < h.r + r + 1.2)) continue;
      // only dodge objects still falling — settled ones just drop into the hole
      if (dropLog.some((d) => t >= d.t0 && t < (d.land ?? d.end) && Math.hypot(d.x - p.x, d.z - p.z) < r + 1.0)) continue;
      if (!shapeFits(shape, p.x, p.z)) {
        // narrow streets: crevasses that run along the road fit far more often
        if (shape.kind === 'pit') continue;
        const base = shape.rot;
        let ok = false;
        for (const rot of [0.08, Math.PI / 2 + 0.08, -0.12, Math.PI / 2 - 0.12]) {
          shape.rot = rot;
          if (shapeFits(shape, p.x, p.z)) { ok = true; break; }
        }
        if (!ok) { shape.rot = base; continue; }
      }
      queueFissure(shape, p.x, p.z, t, ++holeSeq, z.idx);
      return true;
    }
    return false;
  }

  function queueFissure(shape, x, z, t, id, zone) {
    const r = boundR(shape);
    const openAt = t + WARN_TELEGRAPH;
    const expiresAt = openAt + HOLE_LIFETIME;
    holeLog.push({ x, z, r, t0: t, expiresAt, zone });
    fissures.push({
      id, shape, x, z, r, t0: t, openAt, expiresAt,
      state: 'pending', warn: null, pit: null, hole: null,
    });
  }

  /**
   * @param near optional { x, z, dir:[dx,dz], spread } — drop in front of a building
   */
  function spawnDrops(z, t, count = 1, near = null) {
    let spawned = 0;
    const rng = z.rng;
    // Street already littered: skip ambient drops (collapse spill still lands)
    if (!near && dropLog.filter((d) => d.zone === z.idx && t >= d.t0 && t < d.end).length >= ZONE_OBJECT_CAP) return false;
    for (let n = 0; n < count; n++) {
      for (let tries = 0; tries < 10; tries++) {
        let p;
        if (near) {
          const out = rng.range(1.4, 4.2);
          const side = rng.range(-near.spread, near.spread);
          p = {
            x: near.x + near.dir[0] * out + near.dir[1] * side,
            z: near.z + near.dir[1] * out + near.dir[0] * side,
          };
        } else {
          p = sampleSpot(z);
        }
        const s = rng.range(0.5, 1.0);
        const kind = rng.int(0, 3);
        const vy = FALL_SPEED * rng.range(0.9, 1.15);
        if (!p) continue;
        if (!world.isOpenGround(p.x, p.z, 0.15)) continue;
        if (activeHoles(t).some((h) => Math.hypot(h.x - p.x, h.z - p.z) < h.r + 0.6)) continue;
        if (dropLog.some((d) => t >= d.t0 - 0.5 && t < d.end && Math.hypot(d.x - p.x, d.z - p.z) < (d.r ?? 1) + s * 0.7 + 0.5)) continue;
        const fallAt = t + WARN_TELEGRAPH;
        const surf = surfaceMax(p.x, p.z, s * 0.6);
        const restY = surf + s * 0.36;
        const landAt = fallAt + (FALL_HEIGHT - restY) / vy;
        dropLog.push({ x: p.x, z: p.z, r: s * 0.7, t0: t, land: landAt + 0.3, end: landAt + OBJECT_LIFE, zone: z.idx });
        drops.push({
          x: p.x, z: p.z, s, kind, vy, surf, restY,
          radius: s * 0.85,
          t0: t, fallAt, landAt,
          state: 'wait', warn: null, mesh: null,
          seed: hash(seed, 9000 + (++dropSeq)),
        });
        spawned += 1;
        break;
      }
    }
    return spawned > 0;
  }

  function startCollapse(z, t) {
    const living = z.buildings.filter((b) => !b.collapsed && !b.pending);
    if (!living.length) return false;
    const b = living[z.rng.int(0, living.length - 1)];
    b.pending = true;
    b.pendingAt = t;
    b.telegraph = Math.max(0.8, 1.3 - difficulty(t) * 0.55);
    b.baseRotX = b.group.rotation.x;
    b.baseRotZ = b.group.rotation.z;
    b.collapseSeed = hash(seed, 5000 + world.buildings.indexOf(b));
    world.detachBuilding?.(b);
    const fp = b.footprint;
    const dir = FACE_DIR[b.face] || [0, 1];
    const cx = (fp.x0 + fp.x1) / 2;
    const cz = (fp.z0 + fp.z1) / 2;
    const halfDepth = dir[0] ? (fp.x1 - fp.x0) / 2 : (fp.z1 - fp.z0) / 2;
    const halfWidth = dir[0] ? (fp.z1 - fp.z0) / 2 : (fp.x1 - fp.x0) / 2;
    b.front = { x: cx + dir[0] * halfDepth, z: cz + dir[1] * halfDepth, dir, spread: halfWidth };
    // Facade chunks rain onto the street in front, timed with the fall
    spawnDrops(z, t + b.telegraph * 0.4, 1 + (difficulty(t) > 0.5 ? 1 : 0), b.front);
    b.chunks = planCollapseChunks(b, t + b.telegraph);
    b.creaked = false;
    if (t > elapsed - STALE) notify(cx, cz, 'Building giving way!', 0.25);
    return true;
  }

  /**
   * Ballistic rubble thrown toward the street when `b` falls at time T.
   * Closed-form flight so landing spot/time are identical on every client;
   * landings are logged so later hazards keep clear of the rubble.
   */
  function planCollapseChunks(b, T) {
    const vr = rngKit(b.collapseSeed);
    const fp = b.footprint;
    const dir = FACE_DIR[b.face] || [0, 1];
    const cx = (fp.x0 + fp.x1) / 2;
    const cz = (fp.z0 + fp.z1) / 2;
    const n = b.collapseType === 'pancake' ? 9 : 6;
    const speed = b.collapseType === 'facade' ? 9 : 6.5;
    const chunks = [];
    for (let i = 0; i < n; i++) {
      const s = vr.range(0.3, 0.75);
      const p0 = new THREE.Vector3(
        b.front.x + dir[1] * vr.range(-b.front.spread, b.front.spread) * 0.8 - dir[0] * 0.5,
        b.height * vr.range(0.45, 0.8),
        b.front.z + dir[0] * vr.range(-b.front.spread, b.front.spread) * 0.8 - dir[1] * 0.5,
      );
      const v = new THREE.Vector3(
        dir[0] * 8 + vr.range(-2.5, 2.5),
        vr.range(1, 4),
        dir[1] * 8 + vr.range(-2.5, 2.5),
      ).normalize().multiplyScalar(speed * vr.range(0.6, 1.15));
      const restY = 0.1 + s * 0.3;
      const tLand = (v.y + Math.sqrt(v.y * v.y + 2 * GRAVITY * (p0.y - restY))) / GRAVITY;
      const lx = p0.x + v.x * tLand;
      const lz = p0.z + v.z * tLand;
      const settles = world.isOpenGround(lx, lz, 0) && !activeHoles(T + tLand).some((h) => Math.hypot(h.x - lx, h.z - lz) < h.r);
      const c = {
        s, p0, v, tLand, T, lx, lz, restY, settles,
        rot: new THREE.Euler(vr.range(0, 3), vr.range(0, 6), vr.range(0, 3)),
        spin: new THREE.Vector3(vr.range(-4, 4), vr.range(-4, 4), vr.range(-4, 4)),
        mesh: null, collider: null, hitDone: false,
      };
      if (settles) dropLog.push({ x: lx, z: lz, r: s * 0.6, t0: T, land: T + tLand, end: T + tLand + OBJECT_LIFE });
      chunks.push(c);
    }
    return chunks;
  }

  const cars = [];
  let carSeq = 0;

  /** Would a car footprint centred at (x, z) heading along `alongX` hit something solid at time tt? */
  function carBlocked(x, z, alongX, tt) {
    const hx = alongX ? CAR_HALF_L : CAR_HALF_W;
    const hz = alongX ? CAR_HALF_W : CAR_HALF_L;
    if (Math.abs(x) > MAP.half - hx - 0.3 || Math.abs(z) > MAP.half - hz - 0.3) return true;
    for (const c of world.staticColliders) {
      if (x + hx > c.x0 && x - hx < c.x1 && z + hz > c.z0 && z - hz < c.z1) return true;
    }
    for (const d of dropLog) {
      if (tt < (d.land ?? d.t0) || tt >= d.end) continue;
      const r = (d.r ?? 0.6) + 0.2;
      if (Math.abs(d.x - x) < hx + r && Math.abs(d.z - z) < hz + r) return true;
    }
    return false;
  }

  /**
   * Runaway car: drives straight along a road from a random point until the
   * next solid thing (parked car, wreck, rubble, monument, map edge) or a
   * fissure, then crashes there and stays as a solid wreck. The whole path
   * and crash time are fixed at event time → identical on every client.
   */
  function spawnCar(z, t) {
    if (!z.roads?.length) return false;
    for (let tries = 0; tries < 8; tries++) {
      const seg = z.roads[z.rng.int(0, z.roads.length - 1)];
      const dir = z.rng.chance(0.5) ? 1 : -1;
      const s0 = z.rng.range(seg.lo + 2, seg.hi - 2);
      const speed = z.rng.range(12, 16);
      const kind = z.rng.int(0, 2);
      const road = seg.road;
      const alongX = road.axis === 'x';
      const lateral = road.c + (road.half > 2.3 ? (dir > 0 ? -0.75 : 0.75) : 0);
      const pos = (s) => (alongX ? { x: s, z: lateral } : { x: lateral, z: s });
      const goAt = t + CAR_TELEGRAPH;
      const p0 = pos(s0);
      if (carBlocked(p0.x, p0.z, alongX, t)) continue;
      // march forward until something solid / an open hole is in the way
      let travel = 0;
      const maxTravel = 55;
      while (travel < maxTravel) {
        const nxt = travel + 0.5;
        const p = pos(s0 + dir * nxt);
        const tt = goAt + nxt / speed;
        if (carBlocked(p.x, p.z, alongX, tt)) break;
        const front = pos(s0 + dir * (nxt + CAR_HALF_L));
        if (activeHoles(tt).some((h) => Math.hypot(h.x - front.x, h.z - front.z) < h.r * 0.8)) break;
        travel = nxt;
      }
      if (travel < 8) continue;
      const stopAt = goAt + travel / speed;
      const end = pos(s0 + dir * travel);
      const id = ++carSeq;
      dropLog.push({ x: end.x, z: end.z, r: CAR_HALF_L, t0: t, land: stopAt, end: stopAt + OBJECT_LIFE, zone: z.idx });
      cars.push({
        id, kind, alongX, dir, s0, travel, speed, lateral,
        t0: t, goAt, stopAt, endAt: stopAt + OBJECT_LIFE,
        x0: p0.x, z0: p0.z, x1: end.x, z1: end.z,
        state: 'wait', mesh: null, warn: null,
      });
      return true;
    }
    return false;
  }

  function fireOne(z, t) {
    const d = difficulty(t);
    const roll = z.rng.next();
    if (z.index <= 1) return spawnFissure(z, t) || spawnDrops(z, t, 1);
    if (z.index === 2) {
      if (roll < 0.55) return spawnFissure(z, t) || spawnDrops(z, t, 1);
      return spawnDrops(z, t, 1);
    }
    if (roll < 0.38) return spawnDrops(z, t, 1 + (d > 0.4 && z.rng.chance(0.6) ? 1 : 0));
    if (roll < 0.6) return spawnFissure(z, t) || spawnDrops(z, t, 1);
    if (roll < 0.74) return spawnCar(z, t) || spawnDrops(z, t, 1);
    return startCollapse(z, t) || spawnDrops(z, t, 1);
  }

  function fireDueEvents() {
    for (let guard = 0; guard < 6000; guard++) {
      let z = null;
      for (const zz of zones) if (!z || zz.next < z.next) z = zz;
      if (!z || z.next > elapsed) break;
      const t = z.next;
      z.index += 1;
      const d = difficulty(t);
      fireOne(z, t);
      if (d > 0.25 && z.rng.chance(0.42 + d * 0.28)) fireOne(z, t);
      // Ground keeps splitting: extra narrow cracks, more often as it heats up
      if (z.rng.chance(0.3 + d * 0.35)) spawnFissure(z, t, 'crack');
      // Debris rain: an extra falling object most beats, two when it heats up
      if (z.rng.chance(0.45 + d * 0.2)) spawnDrops(z, t, 1);
      z.next = t + scheduleGap(z, t);
    }
    // Trim logs well past relevance
    const horizon = elapsed - HOLE_LIFETIME - 10;
    if (holeLog.length > 200) {
      for (let i = holeLog.length - 1; i >= 0; i--) if (holeLog[i].expiresAt < horizon) holeLog.splice(i, 1);
    }
    if (dropLog.length > 200) {
      for (let i = dropLog.length - 1; i >= 0; i--) if (dropLog[i].end < elapsed - 10) dropLog.splice(i, 1);
    }
  }

  /* ---------------- fissure visuals ---------------- */

  function noise(t, k, ph) {
    return Math.sin(t * 7 + k * 1.7 + ph) * 0.6 + Math.sin(t * 13 - k * 0.9 + ph * 2.3) * 0.4;
  }

  const STRATA = [0x8c6a4a, 0x76583d, 0x9a7a55, 0x6a4d36, 0x84684e];
  const _c = new THREE.Color();

  /** Wall colour by depth below grade: paving edge → gravel base → soil strata, darkening. */
  function wallColor(dd, wobble) {
    if (dd < 0.1) _c.setHex(0x5f5b6a);
    else if (dd < 0.42) _c.setHex(0xa59783);
    else _c.setHex(STRATA[Math.floor((dd + wobble * 0.22) / 0.55) % STRATA.length]);
    const dark = Math.exp(-dd * 0.46);
    _c.multiplyScalar(0.06 + 0.94 * dark);
    return _c;
  }

  function buildPit(f) {
    const { shape, x, z } = f;
    const vr = rngKit(hash(seed, f.id * 7 + 3));
    const ph = vr.range(0, 6.28);
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.name = 'fissure';

    const N = 96;
    const chasm = shape.kind !== 'pit'; // chasms + cracks taper to a V
    // Ring depths every ~0.3 m; scale profile: steep cliff for pits, V-crevasse for chasms
    const rings = [];
    for (let dd = 0; dd <= PIT_DEPTH + 1e-6; dd += 0.3) {
      const u = dd / PIT_DEPTH;
      const s = chasm
        ? 1 - 0.86 * Math.pow(u, 0.8)
        : 1 - 0.2 * Math.pow(u, 1.3);
      const j = dd < 0.2 ? 0 : (chasm ? 0.09 : 0.06) * Math.min(1, dd / 0.8);
      rings.push({ dd, s, j });
    }
    const surf = [];
    const pts = [];
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      const p = pointAt(shape, t, 1);
      pts.push(p);
      surf.push(world.surfaceAt(x + p.x * 1.002, z + p.z * 1.002));
    }
    const positions = [];
    const colors = [];
    const indices = [];
    rings.forEach((rg, k) => {
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        const jit = 1 + rg.j * noise(t, k, ph);
        const p = pointAt(shape, t, rg.s * jit);
        const top = surf[i] + 0.004;
        positions.push(p.x, top - rg.dd, p.z);
        const c = wallColor(rg.dd, noise(t * 0.5, 0, ph));
        colors.push(c.r, c.g, c.b);
      }
    });
    for (let k = 0; k < rings.length - 1; k++) {
      for (let i = 0; i < N; i++) {
        const a = k * N + i;
        const b = k * N + ((i + 1) % N);
        const c = (k + 1) * N + i;
        const d = (k + 1) * N + ((i + 1) % N);
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const walls = new THREE.Mesh(geo, pitMat);
    walls.castShadow = true;
    walls.receiveShadow = true;
    g.add(walls);

    // Floor: near-black, sealed to the bottom ring
    const last = rings[rings.length - 1];
    const floorShape = new THREE.Shape();
    for (let i = 0; i < N; i++) {
      const p = pointAt(shape, (i / N) * Math.PI * 2, last.s * 1.02);
      if (i === 0) floorShape.moveTo(p.x, -p.z);
      else floorShape.lineTo(p.x, -p.z);
    }
    const floorGeo = new THREE.ShapeGeometry(floorShape);
    floorGeo.rotateX(-Math.PI / 2);
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.position.y = -PIT_DEPTH + 0.02;
    g.add(floor);

    // Rubble on the floor — gives the eye a parallax cue for depth
    const deep = [];
    const nDeep = chasm ? 3 : 6;
    for (let i = 0; i < nDeep; i++) {
      const p = pointAt(shape, vr.range(0, 6.28), last.s * vr.range(0.1, 0.75));
      const sz = vr.range(0.3, 0.75);
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(p.x, -PIT_DEPTH + sz * 0.3, p.z),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(vr.range(-0.5, 0.5), vr.range(0, 3), vr.range(-0.5, 0.5))),
        new THREE.Vector3(1, 1, 1),
      );
      deep.push({ geometry: new THREE.BoxGeometry(sz, sz * 0.6, sz * 0.8), matrix: m });
    }
    g.add(new THREE.Mesh(bake(deep), deepRubbleMat));

    // Broken crust: paving slabs heaved up around the lip, overhanging the void
    const crust = { road: [], walk: [] };
    let arc = 0;
    for (let i = 0; i < N; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % N];
      arc += Math.hypot(b.x - a.x, b.z - a.z);
      if (arc < vr.range(0.7, 1.25)) continue;
      arc = 0;
      const len = Math.hypot(a.x, a.z) || 1;
      // outward normal approximated from tangent
      const tx = b.x - a.x;
      const tz = b.z - a.z;
      const tl = Math.hypot(tx, tz) || 1;
      let nx = tz / tl;
      let nz = -tx / tl;
      if (nx * a.x + nz * a.z < 0) { nx = -nx; nz = -nz; }
      const w = vr.range(0.32, 0.62);
      const dpt = vr.range(0.22, 0.42);
      const out = dpt * vr.range(0.05, 0.3);
      const surfY = surf[i];
      const m = new THREE.Matrix4().compose(
        new THREE.Vector3(a.x + nx * out, surfY + 0.015, a.z + nz * out),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(vr.range(0.06, 0.28), Math.atan2(nx, nz), vr.range(-0.12, 0.12), 'YXZ')),
        new THREE.Vector3(1, 1, 1),
      );
      (surfY > 0.12 ? crust.walk : crust.road).push({ geometry: new THREE.BoxGeometry(w, 0.08, dpt), matrix: m });
      void len;
    }
    for (const [list, mat] of [[crust.road, crustRoad], [crust.walk, crustWalk]]) {
      if (!list.length) continue;
      const mesh = new THREE.Mesh(bake(list), mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      g.add(mesh);
    }

    g.add(buildCracks(f, pts, surf, vr, 1));
    return g;
  }

  /** Radial hairline cracks running out from the rim across the paving. */
  function buildCracks(f, pts, surf, vr, reach) {
    const pos = [];
    const idx = [];
    const n = vr.int(7, 11);
    for (let c = 0; c < n; c++) {
      const i0 = Math.floor((c / n) * pts.length + vr.range(0, pts.length / n)) % pts.length;
      const p0 = pts[i0];
      const l0 = Math.hypot(p0.x, p0.z) || 1;
      let dx = p0.x / l0;
      let dz = p0.z / l0;
      let cx = p0.x;
      let cz = p0.z;
      const segs = vr.int(3, 5);
      const total = vr.range(0.9, 2.8) * reach;
      let w = vr.range(0.09, 0.15);
      for (let s = 0; s < segs; s++) {
        const ang = vr.range(-0.55, 0.55);
        const ndx = dx * Math.cos(ang) - dz * Math.sin(ang);
        const ndz = dx * Math.sin(ang) + dz * Math.cos(ang);
        dx = ndx; dz = ndz;
        const L = total / segs;
        const nx2 = cx + dx * L;
        const nz2 = cz + dz * L;
        const w2 = w * 0.6;
        const px = -dz;
        const pz = dx;
        const base = pos.length / 3;
        const y0 = world.surfaceAt(f.x + cx, f.z + cz) + 0.012;
        const y1 = world.surfaceAt(f.x + nx2, f.z + nz2) + 0.012;
        pos.push(cx + px * w, y0, cz + pz * w, cx - px * w, y0, cz - pz * w, nx2, y1, nz2);
        idx.push(base, base + 1, base + 2);
        if (w2 > 0.02) {
          const b2 = pos.length / 3;
          pos.push(nx2 + px * w2, y1, nz2 + pz * w2, nx2 - px * w2, y1, nz2 - pz * w2);
          idx.push(base + 1, b2 + 1, base + 2, base, base + 2, b2);
        }
        cx = nx2; cz = nz2; w = w2;
      }
    }
    void surf;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, crackMat);
    mesh.renderOrder = 1;
    return mesh;
  }

  /** Exact outline of the coming fissure + translucent fill, laid on the paving. */
  function buildFissureWarn(f) {
    const { shape, x, z } = f;
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    const N = 72;
    const lift = (vx, vz) => world.surfaceAt(x + vx, z + vz) + 0.02;

    // Fill
    const fillShape = new THREE.Shape();
    const pts = outlinePts(shape, N, 1);
    pts.forEach((p, i) => (i ? fillShape.lineTo(p.x, -p.z) : fillShape.moveTo(p.x, -p.z)));
    const fillGeo = new THREE.ShapeGeometry(fillShape);
    fillGeo.rotateX(-Math.PI / 2);
    const fp = fillGeo.attributes.position;
    for (let i = 0; i < fp.count; i++) fp.setY(i, lift(fp.getX(i), fp.getZ(i)));
    const fill = new THREE.Mesh(fillGeo, decal(0x1a1420, 0.2));
    fill.renderOrder = 3;
    g.add(fill);

    // Outline band (exact edge of the hole)
    const inner = outlinePts(shape, N, 0.95);
    const outer = outlinePts(shape, N, 1.05);
    const bandPos = [];
    const bandIdx = [];
    for (let i = 0; i < N; i++) {
      bandPos.push(inner[i].x, lift(inner[i].x, inner[i].z) + 0.004, inner[i].z);
      bandPos.push(outer[i].x, lift(outer[i].x, outer[i].z) + 0.004, outer[i].z);
      const a = i * 2;
      const b = ((i + 1) % N) * 2;
      bandIdx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const bandGeo = new THREE.BufferGeometry();
    bandGeo.setAttribute('position', new THREE.Float32BufferAttribute(bandPos, 3));
    bandGeo.setIndex(bandIdx);
    const band = new THREE.Mesh(bandGeo, decal(PAL.danger, 0.8));
    band.renderOrder = 4;
    g.add(band);

    // Hairline cracks that spread from the centre as the warning runs down
    const vr = rngKit(hash(seed, f.id * 7 + 11));
    const cracks = new THREE.Group();
    const cpos = [];
    const cidx = [];
    for (let c = 0; c < 6; c++) {
      const t = (c / 6) * Math.PI * 2 + vr.range(-0.4, 0.4);
      const end = pointAt(shape, t, 0.95);
      let px = 0;
      let pz = 0;
      const segs = 4;
      for (let s = 1; s <= segs; s++) {
        const u = s / segs;
        const jx = s < segs ? vr.range(-0.25, 0.25) : 0;
        const jz = s < segs ? vr.range(-0.25, 0.25) : 0;
        const nx = end.x * u + jx;
        const nz = end.z * u + jz;
        const dx = nx - px;
        const dz = nz - pz;
        const l = Math.hypot(dx, dz) || 1;
        const w = 0.05;
        const ox = (-dz / l) * w;
        const oz = (dx / l) * w;
        const b = cpos.length / 3;
        cpos.push(px + ox, 0, pz + oz, px - ox, 0, pz - oz, nx + ox, 0, nz + oz, nx - ox, 0, nz - oz);
        cidx.push(b, b + 1, b + 2, b + 2, b + 1, b + 3);
        px = nx; pz = nz;
      }
    }
    const cgeo = new THREE.BufferGeometry();
    cgeo.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
    cgeo.setIndex(cidx);
    const cmesh = new THREE.Mesh(cgeo, decal(0x1a1420, 0.85));
    cmesh.renderOrder = 4;
    cracks.add(cmesh);
    cracks.position.y = surfaceMax(x, z, 0.5) + 0.022;
    g.add(cracks);

    g.userData = { fill, band, cracks };
    world.add(g);
    return g;
  }

  function disposeGroup(g) {
    if (!g) return;
    world.root.remove(g);
    g.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose();
        if (o.material && o.material.transparent && !o.material.userData?.shared) o.material.dispose?.();
      }
    });
  }

  function openFissure(f, silent) {
    f.state = 'open';
    if (f.warn) { disposeGroup(f.warn); f.warn = null; }
    f.pit = buildPit(f);
    world.add(f.pit);
    const shape = f.shape;
    const hole = {
      id: f.id,
      x: f.x,
      z: f.z,
      shape,
      scale: silent ? 1 : 0.15,
      bottom: -PIT_DEPTH + 0.5,
      contains(px, pz) {
        return containsOffset(shape, px - f.x, pz - f.z, hole.scale * 0.97);
      },
      /** Nearest safe rim point outside the hole for a rescued faller. */
      rescuePoint(px, pz) {
        const base = Math.atan2(pz - f.z, px - f.x);
        for (let k = 0; k < 16; k++) {
          const a = base + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.4;
          for (let d = 0.6; d < 8; d += 0.4) {
            const qx = f.x + Math.cos(a) * d;
            const qz = f.z + Math.sin(a) * d;
            if (containsOffset(shape, qx - f.x, qz - f.z, 1.15)) continue;
            if (world.holeAt(qx, qz)) continue;
            if (!world.isOpenGround(qx, qz, 0.3)) break;
            return { x: qx, z: qz };
          }
        }
        return null;
      },
    };
    f.hole = hole;
    world.holes.push(hole);
    applyPitScale(f, hole.scale);

    // Loose street props tumble in
    for (const lp of world.looseProps) {
      if (lp.fallen) continue;
      if (!containsOffset(shape, lp.x - f.x, lp.z - f.z, 1.08)) continue;
      lp.fallen = true;
      world.colliders = world.colliders.filter((c) => c.ref !== lp);
      if (silent) {
        lp.obj.visible = false;
      } else {
        fallingProps.push({ obj: lp.obj, vy: 0, life: 1.6, spin: (lp.x * 13.7) % 3 - 1.5 });
      }
    }

    if (!silent) {
      world.juice?.burstDust(f.x, 0.3, f.z, 12, 0.9);
      sfx('hole_open', f.x, f.z, 1);
      world.juice?.impactRing(f.x, f.z, PAL.orange);
      notify(f.x, f.z, null, 0.5);
    }
  }

  function applyPitScale(f, s) {
    if (f.pit) f.pit.scale.set(s, 1, s);
  }

  function closeFissure(f) {
    disposeGroup(f.pit);
    f.pit = null;
    const i = world.holes.indexOf(f.hole);
    if (i >= 0) world.holes.splice(i, 1);
    f.state = 'gone';
  }

  /* ---------------- drop visuals ---------------- */

  function buildDropWarn(d) {
    const g = new THREE.Group();
    g.position.set(d.x, d.surf + 0.02, d.z);
    const R = d.radius * 1.15;
    const shadow = new THREE.Mesh(new THREE.CircleGeometry(R, 40), decal(0x0c0a10, 0.3));
    shadow.rotation.x = -Math.PI / 2;
    shadow.renderOrder = 3;
    const target = new THREE.Mesh(new THREE.RingGeometry(R * 0.94, R * 1.06, 48), decal(PAL.danger, 0.75));
    target.rotation.x = -Math.PI / 2;
    target.position.y = 0.003;
    target.renderOrder = 4;
    const closing = new THREE.Mesh(new THREE.RingGeometry(R * 0.9, R, 48), decal(PAL.danger, 0.6));
    closing.rotation.x = -Math.PI / 2;
    closing.position.y = 0.005;
    closing.renderOrder = 4;
    g.add(shadow, target, closing);
    g.userData = { shadow, target, closing };
    world.add(g);
    return g;
  }

  const dropMats = {
    concrete: cel({ color: PAL.concreteDark, bands: 3, tint: 0x4a4038 }),
    rubble: cel({ color: PAL.rubble, bands: 3, tint: 0x4a4038 }),
    white: cel({ color: PAL.wallWhite, bands: 3, tint: 0x6f6790 }),
    grille: cel({ color: PAL.metalDark, bands: 2, tint: 0x5c5680 }),
    roof: cel({ color: PAL.roofSlate, bands: 3, tint: 0x514b70 }),
    pot: cel({ color: PAL.clay, bands: 3, tint: 0x7a4060 }),
    leaf: cel({ color: PAL.leaf, bands: 3, tint: 0x5b6f8c }),
  };

  function buildDropMesh(d) {
    const s = d.s;
    const g = new THREE.Group();
    if (d.kind === 0) {
      g.add(box(s, s * 0.75, s * 0.85, dropMats.concrete));
      g.add(box(s * 0.5, s * 0.35, s * 0.5, dropMats.rubble, s * 0.2, s * 0.45, 0));
    } else if (d.kind === 1) {
      // air-con unit
      g.add(box(s * 1.2, s * 0.75, s * 0.5, dropMats.white));
      g.add(box(s * 0.5, s * 0.5, 0.04, dropMats.grille, -s * 0.22, 0, s * 0.26));
    } else if (d.kind === 2) {
      // roof tile stack
      for (let i = 0; i < 4; i++) g.add(box(s * 1.1, s * 0.12, s * 0.7, dropMats.roof, 0, i * s * 0.14 - s * 0.2, (i % 2) * 0.05));
    } else {
      // planter pot
      g.add(box(s * 0.8, s * 0.6, s * 0.8, dropMats.pot));
      g.add(box(s * 0.65, s * 0.4, s * 0.65, dropMats.leaf, 0, s * 0.45, 0));
    }
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    const vr = rngKit(d.seed);
    g.rotation.set(vr.range(0, 1), vr.range(0, 6), vr.range(0, 1));
    d.spin = new THREE.Vector3(vr.range(-5, 5), vr.range(-3, 3), vr.range(-5, 5));
    world.add(g);
    return g;
  }

  /* ---------------- collapses ---------------- */

  function collapseBuilding(b, silent) {
    if (b.collapsed) return;
    b.collapsed = true;
    b.pending = false;
    const fp = b.footprint;
    const cx = (fp.x0 + fp.x1) / 2;
    const cz = (fp.z0 + fp.z1) / 2;

    world.root.remove(b.group);
    world.colliders = world.colliders.filter((c) => c.ref !== b);
    world.add(makeRubble(fp, b.height, b.collapseSeed || 1));
    world.collide(fp.x0 + 0.3, fp.z0 + 0.3, fp.x1 - 0.3, fp.z1 - 0.3, 1.1, undefined, b);
    if (silent) {
      for (const c of b.chunks || []) debris.push(c);
      return;
    }
    sfx('collapse', cx, cz, 1);

    for (const c of b.chunks || []) debris.push(c);
    world.collapseZones.push({
      x0: fp.x0 - 0.4, x1: fp.x1 + 0.4,
      z0: fp.z0 - 0.4, z1: fp.z1 + 0.4,
      life: 0.85,
      kind: 'collapse',
    });
    world.juice?.burstDust(cx, b.height * 0.4, cz, 28, 1.6);
    world.juice?.impactRing(cx, cz, PAL.red);
    notify(cx, cz, null, 0.85);
  }

  /* ---------------- frame update ---------------- */

  function update(dt, player) {
    if (typeof world.roomElapsed === 'number') elapsed = Math.max(elapsed, world.roomElapsed);
    else elapsed += dt;
    if (player?.pos) {
      listener.x = player.pos.x;
      listener.z = player.pos.z;
      listener.set = !!player.alive && !!player.playing;
    }

    fireDueEvents();

    // Buildings telegraph → collapse
    for (const b of world.buildings) {
      if (!b.pending || b.collapsed) continue;
      const age = elapsed - b.pendingAt;
      if (age >= b.telegraph) {
        collapseBuilding(b, age - b.telegraph > STALE);
        continue;
      }
      if (age < 0) continue;
      if (!b.creaked && age < b.telegraph * 0.8) {
        b.creaked = true;
        const fp = b.footprint;
        sfx('creak', (fp.x0 + fp.x1) / 2, (fp.z0 + fp.z1) / 2, 0.9);
      }
      const t = Math.min(1, age / b.telegraph);
      const shake = Math.sin(elapsed * 28) * 0.025 * Math.min(1, t * 2);
      if (b.collapseType === 'lean') b.group.rotation.z = (b.baseRotZ || 0) + shake * 3 + t * 0.08;
      else if (b.collapseType === 'facade') b.group.rotation.x = (b.baseRotX || 0) + shake * 2 + t * 0.05;
      else b.group.position.y = Math.sin(elapsed * 22) * 0.04 * t;
    }

    // Fissures: warn → open (animated) → close
    for (let i = fissures.length - 1; i >= 0; i--) {
      const f = fissures[i];
      if (f.state === 'pending') {
        if (elapsed >= f.expiresAt + HOLE_CLOSE) { fissures.splice(i, 1); continue; }
        if (elapsed >= f.openAt) {
          openFissure(f, elapsed - f.openAt > STALE);
        } else {
          if (!f.warn) {
            f.warn = buildFissureWarn(f);
            if (elapsed - f.t0 < WARN_TELEGRAPH * 0.8) {
              notify(f.x, f.z, 'Ground cracking!', 0.12);
              sfx('crack', f.x, f.z, 0.9);
            }
          }
          const u = Math.min(1, (elapsed - f.t0) / WARN_TELEGRAPH);
          const pulse = 0.5 + 0.5 * Math.sin(elapsed * 18);
          const ud = f.warn.userData;
          ud.fill.material.opacity = 0.12 + u * 0.38;
          ud.band.material.opacity = 0.45 + 0.45 * pulse;
          ud.cracks.scale.set(0.15 + u * 0.85, 1, 0.15 + u * 0.85);
          continue;
        }
      }
      if (f.state === 'open') {
        const hole = f.hole;
        if (elapsed >= f.expiresAt) {
          const u = Math.min(1, (elapsed - f.expiresAt) / HOLE_CLOSE);
          hole.scale = Math.max(0.001, 1 - u);
          applyPitScale(f, hole.scale);
          if (u >= 1) { closeFissure(f); fissures.splice(i, 1); }
        } else if (hole.scale < 1) {
          const u = Math.min(1, (elapsed - f.openAt) / HOLE_OPEN);
          hole.scale = 0.15 + 0.85 * (1 - Math.pow(1 - u, 3));
          applyPitScale(f, hole.scale);
        }
      }
    }
    setHolePunches(world.holes.map((h) => ({ x: h.x, z: h.z, shape: h.shape, scale: h.scale })));

    // Falling street props
    for (let i = fallingProps.length - 1; i >= 0; i--) {
      const p = fallingProps[i];
      p.vy -= 18 * dt;
      p.obj.position.y += p.vy * dt;
      p.obj.rotation.z += p.spin * dt;
      p.life -= dt;
      if (p.life <= 0) {
        world.root.remove(p.obj);
        fallingProps.splice(i, 1);
      }
    }

    updateDrops(dt, player);
    updateDebris(dt, player);
    updateCars(dt, player);
    world.flushBlocks?.();
  }

  /** Solid AABB for a settled object (drop or rubble chunk). */
  function addSolid(owner, x, z, half) {
    if (owner.alongX !== undefined && !half) {
      const hx = owner.alongX ? CAR_HALF_L : CAR_HALF_W;
      const hz = owner.alongX ? CAR_HALF_W : CAR_HALF_L;
      world.collide(x - hx, z - hz, x + hx, z + hz, 1.8, undefined, owner);
      owner.solid = true;
      return;
    }
    world.collide(x - half, z - half, x + half, z + half, 1.6, undefined, owner);
    owner.solid = true;
  }

  function removeSolid(owner) {
    if (!owner.solid) return;
    world.colliders = world.colliders.filter((c) => c.ref !== owner);
    owner.solid = false;
  }

  /** Push the player out if an object just landed on top of them. */
  function hitCheckFalling(player, x, z, r, y, opts) {
    if (!player?.alive) return;
    const dx = x - player.pos.x;
    const dz = z - player.pos.z;
    const rel = y - player.pos.y;
    if (Math.hypot(dx, dz) < r + 0.42 && rel > -0.3 && rel < 2.0) {
      player.takeHit('debris', { kx: -dx * 3, kz: -dz * 3, ...opts });
    }
  }

  const IMPACT_SFX = ['impact_concrete', 'impact_metal', 'impact_tiles', 'impact_pot'];

  function updateDrops(dt, player) {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      if (elapsed < d.t0) continue;
      const endAt = d.landAt + OBJECT_LIFE;
      if (elapsed > endAt) {
        disposeGroup(d.warn);
        if (d.mesh) world.root.remove(d.mesh);
        removeSolid(d);
        drops.splice(i, 1);
        continue;
      }
      if (d.state === 'wait') {
        if (elapsed > d.landAt + STALE) {
          // Late join / catch-up: it's already lying there
          d.mesh = buildDropMesh(d);
          d.mesh.position.set(d.x, d.restY, d.z);
          d.mesh.rotation.set(0, d.mesh.rotation.y, 0);
          d.state = 'landed';
          addSolid(d, d.x, d.z, d.s * 0.55);
          continue;
        }
        d.warn = buildDropWarn(d);
        d.state = 'warn';
        if (elapsed - d.t0 < WARN_TELEGRAPH * 0.8) notify(d.x, d.z, 'Debris falling!', 0.1);
      }
      const ud = d.warn?.userData;
      if (d.state === 'warn' || d.state === 'fall') {
        const u = Math.min(1, (elapsed - d.t0) / WARN_TELEGRAPH);
        // Closing reticle: 2.2× → 1× over the telegraph
        if (ud) {
          const k = 2.2 - 1.2 * u;
          ud.closing.scale.set(k, k, 1);
          ud.closing.material.opacity = 0.35 + 0.5 * u;
          // Shadow sharpens as the object nears the ground
          const yNow = d.state === 'fall' ? d.mesh.position.y : FALL_HEIGHT;
          const near = 1 - Math.min(1, (yNow - d.restY) / (FALL_HEIGHT - d.restY));
          ud.shadow.material.opacity = 0.22 + 0.25 * u + 0.4 * near;
          const sc = 0.7 + 0.15 * u + 0.3 * near;
          ud.shadow.scale.set(sc, sc, 1);
        }
      }
      if (d.state === 'warn' && elapsed >= d.fallAt) {
        d.mesh = buildDropMesh(d);
        d.state = 'fall';
        sfx('whoosh', d.x, d.z, 0.55);
      }
      if (d.state === 'fall') {
        const y = Math.max(d.restY, FALL_HEIGHT - d.vy * (elapsed - d.fallAt));
        d.mesh.position.set(d.x, y, d.z);
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.mesh.rotation.z += d.spin.z * dt;
        hitCheckFalling(player, d.x, d.z, d.radius, y);
        if (elapsed >= d.landAt) {
          d.state = 'landed';
          d.mesh.position.y = d.restY;
          d.mesh.rotation.set(0, d.mesh.rotation.y, 0);
          d.squash = 0.35;
          world.juice?.burstDust(d.x, d.surf + 0.3, d.z, 16, 1.25);
          world.juice?.impactRing(d.x, d.z, PAL.danger);
          notify(d.x, d.z, null, 0.4);
          sfx(IMPACT_SFX[d.kind] || 'impact_concrete', d.x, d.z, 1);
          if (d.warn) { disposeGroup(d.warn); d.warn = null; }
          addSolid(d, d.x, d.z, d.s * 0.55);
        }
      }
      if (d.state === 'landed' && d.mesh) {
        if (d.squash > 0) {
          d.squash = Math.max(0, d.squash - dt * 2.5);
          const k = d.squash / 0.35;
          d.mesh.scale.set(1 + 0.25 * k, 1 - 0.35 * k, 1 + 0.25 * k);
        }
        // a fissure opening under it swallows it
        if (world.holeAt(d.x, d.z)) {
          d.mesh.position.y -= 9 * dt;
          removeSolid(d);
        }
        // sink away during the last second
        const rem = endAt - elapsed;
        if (rem < 1) d.mesh.position.y = Math.min(d.mesh.position.y, d.restY - (1 - rem) * 1.0);
        if (rem < 1) removeSolid(d);
      }
    }
  }

  function buildCarWarn(c) {
    const g = new THREE.Group();
    const len = c.travel + CAR_HALF_L * 2;
    const w = CAR_HALF_W * 2 + 0.3;
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(len, w), decal(PAL.danger, 0.3));
    stripe.rotation.x = -Math.PI / 2;
    stripe.renderOrder = 3;
    g.add(stripe);
    // chevrons pointing the way it will come
    const chev = new THREE.Shape();
    chev.moveTo(-0.35, -0.55); chev.lineTo(0.25, 0); chev.lineTo(-0.35, 0.55);
    chev.lineTo(-0.05, 0.55); chev.lineTo(0.55, 0); chev.lineTo(-0.05, -0.55);
    const chevGeo = new THREE.ShapeGeometry(chev);
    chevGeo.rotateX(-Math.PI / 2);
    const chevMat = decal(PAL.danger, 0.85);
    for (let k = -len / 2 + 2; k < len / 2 - 1; k += 2.2) {
      const m = new THREE.Mesh(chevGeo, chevMat);
      m.position.set(k, 0.004, 0);
      m.renderOrder = 4;
      g.add(m);
    }
    const midS = c.s0 + c.dir * (c.travel / 2);
    const mid = c.alongX ? { x: midS, z: c.lateral } : { x: c.lateral, z: midS };
    g.position.set(mid.x, world.surfaceAt(mid.x, mid.z) + 0.025, mid.z);
    // local +X must point along travel
    g.rotation.y = c.alongX ? (c.dir > 0 ? 0 : Math.PI) : (c.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
    g.userData = { stripe, chevMat };
    world.add(g);
    return g;
  }

  function buildCarMesh(c) {
    const colors = [PAL.red, PAL.blue, PAL.taxiYellow, PAL.teal, PAL.orange];
    const ry = c.alongX ? (c.dir > 0 ? 0 : Math.PI) : (c.dir > 0 ? -Math.PI / 2 : Math.PI / 2);
    const o = { x: c.x0, y: 0.1, z: c.z0, ry, color: colors[c.id % colors.length], hero: false };
    const mesh = c.kind === 0 ? makeSedan(o) : c.kind === 1 ? makeVan(o) : makeKeiTruck(o);
    world.add(mesh);
    return mesh;
  }

  function updateCars(dt, player) {
    for (let i = cars.length - 1; i >= 0; i--) {
      const c = cars[i];
      if (elapsed < c.t0) continue;
      if (elapsed > c.endAt) {
        disposeGroup(c.warn);
        if (c.mesh) world.root.remove(c.mesh);
        removeSolid(c);
        cars.splice(i, 1);
        continue;
      }
      if (c.state === 'wait') {
        c.mesh = buildCarMesh(c);
        if (elapsed > c.stopAt + STALE) {
          c.mesh.position.set(c.x1, 0.1, c.z1);
          c.mesh.rotation.z = 0.04;
          c.state = 'wreck';
          addSolid(c, c.x1, c.z1, 0);
          continue;
        }
        c.warn = buildCarWarn(c);
        c.state = 'warn';
        if (elapsed - c.t0 < CAR_TELEGRAPH * 0.8) {
          notify(c.x0, c.z0, 'Runaway car!', 0.1);
          sfx('horn', c.x0, c.z0, 1);
        }
      }
      if (c.state === 'warn') {
        const u = Math.min(1, (elapsed - c.t0) / CAR_TELEGRAPH);
        const ud = c.warn.userData;
        ud.stripe.material.opacity = 0.18 + 0.3 * u * (0.6 + 0.4 * Math.sin(elapsed * 20));
        ud.chevMat.opacity = 0.5 + 0.45 * Math.sin(elapsed * 16 - u * 6);
        c.mesh.position.y = 0.1 + Math.abs(Math.sin(elapsed * 30)) * 0.03; // revving
        if (elapsed >= c.goAt) {
          c.state = 'drive';
          sfx('car_rush', c.x0, c.z0, 1);
        }
      }
      if (c.state === 'drive') {
        const d = Math.min(c.travel, (elapsed - c.goAt) * c.speed);
        const s = c.s0 + c.dir * d;
        const x = c.alongX ? s : c.lateral;
        const z = c.alongX ? c.lateral : s;
        c.mesh.position.set(x, 0.1, z);
        if (player?.alive) {
          const along = c.alongX ? player.pos.x - x : player.pos.z - z;
          const across = c.alongX ? player.pos.z - z : player.pos.x - x;
          if (Math.abs(along) < CAR_HALF_L + 0.3 && Math.abs(across) < CAR_HALF_W + 0.35) {
            const side = Math.sign(across) || 1;
            const fx = c.alongX ? c.dir * 6 : side * 5;
            const fz = c.alongX ? side * 5 : c.dir * 6;
            player.takeHit('car', { kx: fx, kz: fz, shake: 1.2 });
          }
        }
        if (elapsed >= c.stopAt) {
          c.state = 'wreck';
          c.mesh.position.set(c.x1, 0.1, c.z1);
          c.mesh.rotation.z = 0.05;
          c.mesh.rotation.y += 0.12 * (c.id % 2 ? 1 : -1);
          disposeGroup(c.warn);
          c.warn = null;
          world.juice?.burstDust(c.x1, 0.6, c.z1, 18, 1.3);
          world.juice?.impactRing(c.x1, c.z1, PAL.danger);
          notify(c.x1, c.z1, null, 0.5);
          sfx('car_crash', c.x1, c.z1, 1);
          addSolid(c, c.x1, c.z1, 0);
        }
      }
      if (c.state === 'wreck' && world.holeAt(c.x1, c.z1)) {
        c.mesh.position.y -= 9 * dt;
        removeSolid(c);
      }
      if (c.state === 'wreck') {
        const rem = c.endAt - elapsed;
        if (rem < 1) {
          c.mesh.position.y = Math.min(c.mesh.position.y, 0.1 - (1 - rem) * 1.6);
          removeSolid(c);
        }
      }
    }
  }

  /** Collapse rubble: closed-form flight from collapse time, then solid. */
  function updateDebris(dt, player) {
    const pos = player?.pos;
    for (let i = debris.length - 1; i >= 0; i--) {
      const c = debris[i];
      const age = elapsed - c.T;
      const endAt = c.tLand + OBJECT_LIFE;
      if (age > endAt || (!c.settles && age > c.tLand)) {
        if (c.mesh) world.root.remove(c.mesh);
        removeSolid(c);
        debris.splice(i, 1);
        continue;
      }
      if (!c.mesh) {
        c.mesh = box(c.s, c.s * 0.7, c.s * 0.8, rubbleMat);
        c.mesh.castShadow = true;
        c.mesh.receiveShadow = true;
        c.mesh.rotation.copy(c.rot);
        world.add(c.mesh);
      }
      if (age < c.tLand) {
        c.mesh.position.set(
          c.p0.x + c.v.x * age,
          c.p0.y + c.v.y * age - 0.5 * GRAVITY * age * age,
          c.p0.z + c.v.z * age,
        );
        c.mesh.rotation.x += c.spin.x * dt;
        c.mesh.rotation.y += c.spin.y * dt;
        c.mesh.rotation.z += c.spin.z * dt;
        if (player?.alive && !c.hitDone) {
          const dx = c.mesh.position.x - pos.x;
          const dy = c.mesh.position.y - (pos.y + 1.0);
          const dz = c.mesh.position.z - pos.z;
          if (Math.hypot(dx, dy, dz) < c.s * 0.45 + 0.45) {
            c.hitDone = true;
            player.takeHit('debris', { kx: -dx * 2.5, kz: -dz * 2.5 });
          }
        }
      } else if (!c.landed) {
        c.landed = true;
        c.mesh.position.set(c.lx, c.restY, c.lz);
        c.mesh.rotation.set(0, c.rot.y, 0);
        if (c.s > 0.42) addSolid(c, c.lx, c.lz, c.s * 0.45);
      } else {
        if (world.holeAt(c.lx, c.lz)) {
          c.mesh.position.y -= 9 * dt;
          removeSolid(c);
        }
        const rem = endAt - age;
        if (rem < 1) {
          c.mesh.position.y = Math.min(c.mesh.position.y, c.restY - (1 - rem) * 0.8);
          removeSolid(c);
        }
      }
    }

    for (let i = world.collapseZones.length - 1; i >= 0; i--) {
      const z = world.collapseZones[i];
      z.life -= dt;
      if (player?.alive && pos.x > z.x0 && pos.x < z.x1 && pos.z > z.z0 && pos.z < z.z1) {
        player.takeHit(z.kind === 'collapse' ? 'collapse' : 'debris', { shake: 1.1 });
      }
      if (z.life <= 0) world.collapseZones.splice(i, 1);
    }
  }

  function reset() {
    for (const f of fissures) { disposeGroup(f.warn); disposeGroup(f.pit); }
    for (const d of drops) { disposeGroup(d.warn); if (d.mesh) world.root.remove(d.mesh); removeSolid(d); }
    for (const d of debris) { if (d.mesh) world.root.remove(d.mesh); removeSolid(d); }
    for (const c of cars) { disposeGroup(c.warn); if (c.mesh) world.root.remove(c.mesh); removeSolid(c); }
    cars.length = 0;
    fissures.length = 0;
    drops.length = 0;
    debris.length = 0;
    world.holes.length = 0;
    clearHolePunches();
  }
  clearHolePunches();

  /* ---------------- debug hooks (local only, never touch zone RNGs) ---- */
  if (typeof window !== 'undefined') {
    window.__aftershockSpawnFissure = (x, z, kind) => {
      const shape = makeShape(debugRng, kind);
      if (x == null) {
        const p = listener.set ? listener : { x: 0, z: 0 };
        x = p.x + 6;
        z = p.z;
      }
      queueFissure(shape, x, z, elapsed, ++debugSeq, -1);
      return { x, z, kind: shape.kind };
    };
    /** Debug: launch a runaway car somewhere in the zone containing (x, z). */
    window.__aftershockSpawnCar = (x = listener.x, z = listener.z) => {
      const zone = zones.find((zz) => zz.inRegion(x, z)) || zones[0];
      return spawnCar({ ...zone, rng: debugRng }, elapsed);
    };
    /** Debug: make the nearest standing house to (x, z) give way now. */
    window.__aftershockCollapseNear = (x, z) => {
      let best = null;
      let bd = Infinity;
      for (const b of world.buildings) {
        if (b.collapsed || b.pending) continue;
        const d = Math.hypot((b.footprint.x0 + b.footprint.x1) / 2 - x, (b.footprint.z0 + b.footprint.z1) / 2 - z);
        if (d < bd) { bd = d; best = b; }
      }
      if (!best) return false;
      const fake = { rng: debugRng, buildings: [best], rects: [], area: 0, inRegion: () => false };
      return startCollapse(fake, elapsed);
    };
    window.__aftershockSpawnDrop = (x, z) => {
      const before = drops.length;
      const fake = { rng: debugRng, rects: [{ x0: x - 0.01, x1: x + 0.01, z0: z - 0.01, z1: z + 0.01, a: 1 }], area: 1, inRegion: () => true };
      spawnDrops(fake, elapsed, 1);
      return drops.length > before;
    };
  }

  return {
    update, reset,
    get elapsed() { return elapsed; },
    get fissureCount() { return fissures.length; },
    get dropCount() { return drops.length; },
    get cars() { return cars.map((c) => ({ x0: c.x0, z0: c.z0, x1: c.x1, z1: c.z1, state: c.state, travel: c.travel })); },
  };
}
