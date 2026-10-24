import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { rngKit, box, bake, mergeStatic } from '../core/util.js';
import { makeRubble } from './buildings.js';
import { makeSedan, makeVan, makeKeiTruck } from './props.js';
import { MAP } from './street.js';
import { createHazardFx } from './hazardFx.js';
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
 * Collapsing houses hit everyone inside a blast radius (red ring during the
 * telegraph); runaway cars hit anything they sweep over along the lane.
 */

const WARN_TELEGRAPH = 1.0;
const HOLE_LIFETIME = 60;
const HOLE_OPEN = 0.45;
const HOLE_CLOSE = 0.7;
const PIT_DEPTH = 6.5;
const FALL_HEIGHT = 14;
const FALL_SPEED = 22;
/** Per-zone open-fissure cap ramps with intensity: 4 at the start → 12. */
const ZONE_HOLE_CAP_MIN = 4;
const ZONE_HOLE_CAP_MAX = 12;
/** Walkable area of the old single-cross map — hazard density reference. */
const REF_AREA = 1240;
const NOTIFY_RADIUS = 28;
const STALE = 1.2;
/** Collapsed houses become walkable rubble heaps that hazards target too. */
const RUBBLE_TOP = 0.42;
const RUBBLE_WEIGHT = 3;
/** Fallen objects / settled rubble stay on the street (and stay solid) this long. */
const OBJECT_LIFE = 90;
/** Max objects lying in / falling onto one zone at once (keeps streets passable). */
const ZONE_OBJECT_CAP_MIN = 24;
const ZONE_OBJECT_CAP_MAX = 80;
const GRAVITY = 14;
/** Runaway car: honk + lane warning, then it tears down the street. */
const CAR_TELEGRAPH = 1.2;
const CAR_HALF_L = 1.8;
const CAR_HALF_W = 0.8;
/** Extra danger width either side of a runaway car (matches the red lane stripe). */
const CAR_HIT_PAD = 0.55;
const CAR_CRASH_R = 2.2;
/** Fires ignite at houses (front or rubble) and never go out. */
const FIRE_TELEGRAPH = 1.6;
const FIRE_CAP_MIN = 2;
const FIRE_CAP_MAX = 8;
/** Gas blasts at house fronts; hazard drums that blow up after landing. */
const BLAST_TELEGRAPH = 1.7;
const BOMB_FUSE = 2.4;
const BOMB_R = 2.8;

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
    // small zones (the plaza) no longer get stretched-out, calmer spacing
    gapScale: Math.min(1.0, Math.max(0.55, REF_AREA / Math.max(1, z.area))),
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
  const crustVC = cel({ color: 0xffffff, vertexColors: true, bands: 3, tint: 0x6a608f });
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
  /**
   * Quake intensity over the shared round clock — calm start, steady build:
   * 0.4 at 0 s · ~1.0 at 30 s · ~1.4 at 1 min · ~2.0 at 2 min · ~2.8 at 5 min
   * · ~3.6 at 10 min. Scales hazard frequency, caps and extra rolls.
   */
  function intensity(t) {
    return 0.4 + 2.6 * (1 - Math.exp(-t / 120)) + Math.min(0.6, t / 1000);
  }

  /** 0 → 1 ramp of the intensity curve (for caps / chances). */
  function ramp(t) {
    return Math.min(1, Math.max(0, (intensity(t) - 0.4) / 2.6));
  }

  /** Hazard mix / secondary-event pressure. */
  function difficulty(t) {
    return Math.min(1.6, t / 90);
  }

  /** Japanese seismic intensity (shindo 1–7) for the HUD. */
  function shindo(t) {
    return Math.max(1, Math.min(7, Math.round(1 + (intensity(t) - 0.4) / 3.2 * 6)));
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

  /** Rubble heaps logged at event time: { x0, x1, z0, z1, a, T, zone }. */
  const rubbleLog = [];

  function rubbleAt(x, z, t, margin = 0) {
    for (const r of rubbleLog) {
      if (t < r.T) continue;
      if (x > r.x0 + margin && x < r.x1 - margin && z > r.z0 + margin && z < r.z1 - margin) return r;
    }
    return null;
  }

  /** Open paving OR a rubble heap that already exists at event time t. */
  function isOpen(x, z, margin, t) {
    return world.isOpenGround(x, z, margin) || !!rubbleAt(x, z, t, margin);
  }

  /** Deterministic ground height for placement (rubble from the event log, not live platforms). */
  function groundAt(x, z, t) {
    return rubbleAt(x, z, t) ? Math.max(RUBBLE_TOP, world.surfaceAt(x, z)) : world.surfaceAt(x, z);
  }

  /** Visual ground height right now (pit rims, decals). */
  function surfVis(x, z) {
    return groundAt(x, z, elapsed);
  }

  /** Weighted spot over open paving + this zone's rubble heaps (3× weight: no safe havens). */
  function sampleSpot(z, t) {
    const heaps = rubbleLog.filter((r) => r.zone === z.idx && t >= r.T);
    const heapArea = heaps.reduce((acc, r) => acc + r.a * RUBBLE_WEIGHT, 0);
    const total = z.area + heapArea;
    if (!total) return null;
    let r = z.rng.next() * total;
    let rect = null;
    let onHeap = false;
    for (const c of z.rects) {
      r -= c.a;
      if (r <= 0) { rect = c; break; }
    }
    if (!rect) {
      for (const h of heaps) {
        r -= h.a * RUBBLE_WEIGHT;
        if (r <= 0) { rect = h; onHeap = true; break; }
      }
    }
    rect ||= z.rects[z.rects.length - 1] || heaps[heaps.length - 1];
    const x = z.rng.range(rect.x0, rect.x1);
    const zz = z.rng.range(rect.z0, rect.z1);
    if (!onHeap && !z.inRegion(x, zz)) return null;
    return { x, z: zz };
  }

  function activeHoles(t) {
    return holeLog.filter((h) => t >= h.t0 && t < h.expiresAt + HOLE_CLOSE);
  }

  function shapeFits(shape, x, z, t) {
    if (!isOpen(x, z, 0.2, t)) return false;
    for (let i = 0; i < 40; i++) {
      const p = pointAt(shape, (i / 40) * Math.PI * 2, 1.12);
      if (!isOpen(x + p.x, z + p.z, 0.15, t)) return false;
    }
    return true;
  }

  function surfaceMax(x, z, r, t = elapsed) {
    let y = groundAt(x, z, t);
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      y = Math.max(y, groundAt(x + Math.cos(a) * r, z + Math.sin(a) * r, t));
    }
    return y;
  }

  /* ---------------- scheduling ---------------- */
  function scheduleGap(z, t) {
    const d = difficulty(t);
    return (Math.max(1.35, 6.5 - d * 4.5) + z.rng.range(0, 1.6)) * z.gapScale / intensity(t);
  }

  function spawnFissure(z, t, kind) {
    const active = activeHoles(t);
    if (active.length >= MAX_HOLES) return false;
    const cap = Math.round(ZONE_HOLE_CAP_MIN + (ZONE_HOLE_CAP_MAX - ZONE_HOLE_CAP_MIN) * ramp(t));
    if (active.filter((h) => h.zone === z.idx).length >= cap) return false;
    for (let i = 0; i < 20; i++) {
      const p = sampleSpot(z, t);
      const shape = makeShape(z.rng, kind);
      if (!p) continue;
      const r = boundR(shape);
      if (active.some((h) => Math.hypot(h.x - p.x, h.z - p.z) < h.r + r + 1.2)) continue;
      // only dodge objects still falling — settled ones just drop into the hole
      if (dropLog.some((d) => t >= d.t0 && t < (d.land ?? d.end) && Math.hypot(d.x - p.x, d.z - p.z) < r + 1.0)) continue;
      if (!shapeFits(shape, p.x, p.z, t)) {
        // narrow streets: crevasses that run along the road fit far more often
        if (shape.kind === 'pit') continue;
        const base = shape.rot;
        let ok = false;
        for (const rot of [0.08, Math.PI / 2 + 0.08, -0.12, Math.PI / 2 - 0.12]) {
          shape.rot = rot;
          if (shapeFits(shape, p.x, p.z, t)) { ok = true; break; }
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
    const objCap = Math.round(ZONE_OBJECT_CAP_MIN + (ZONE_OBJECT_CAP_MAX - ZONE_OBJECT_CAP_MIN) * ramp(t));
    if (!near && dropLog.filter((d) => d.zone === z.idx && t >= d.t0 && t < d.end).length >= objCap) return false;
    /** Free distance from (x, z) to the nearest crack or object edge at time t. */
    const clearance = (x, zz, t) => {
      let c = Infinity;
      for (const h of activeHoles(t)) c = Math.min(c, Math.hypot(h.x - x, h.z - zz) - h.r);
      for (const d of dropLog) {
        if (t < d.t0 - 0.5 || t >= d.end) continue;
        c = Math.min(c, Math.hypot(d.x - x, d.z - zz) - (d.r ?? 1));
      }
      return c;
    };
    for (let n = 0; n < count; n++) {
      // Sample several valid spots and drop on the emptiest one — objects
      // never land on cracks or on each other, and spread over open ground.
      let best = null;
      let valid = 0;
      for (let tries = 0; tries < 18 && valid < (near ? 3 : 6); tries++) {
        let p;
        if (near) {
          const out = rng.range(1.4, 4.2);
          const side = rng.range(-near.spread, near.spread);
          p = {
            x: near.x + near.dir[0] * out + near.dir[1] * side,
            z: near.z + near.dir[1] * out + near.dir[0] * side,
          };
        } else {
          p = sampleSpot(z, t);
        }
        const s = rng.range(0.5, 1.0);
        if (!p) continue;
        if (!isOpen(p.x, p.z, 0.15, t)) continue;
        const c = clearance(p.x, p.z, t) - s * 0.7;
        if (c < 0.6) continue;
        valid += 1;
        if (!best || c > best.c) best = { p, s, c };
      }
      if (!best) continue;
      const { p, s } = best;
      const bomb = !near && t > 20 && rng.chance(0.05 + 0.12 * ramp(t));
      const kind = bomb ? 4 : rng.int(0, 3);
      const vy = FALL_SPEED * rng.range(0.9, 1.15);
      const fallAt = t + WARN_TELEGRAPH;
      const surf = surfaceMax(p.x, p.z, s * 0.6, t);
      const restY = surf + s * 0.36;
      const landAt = fallAt + (FALL_HEIGHT - restY) / vy;
      // a hazard drum lies there only until its fuse runs out
      const explodeAt = bomb ? landAt + BOMB_FUSE : null;
      dropLog.push({ x: p.x, z: p.z, r: s * 0.7, t0: t, land: landAt + 0.3, end: bomb ? explodeAt : landAt + OBJECT_LIFE, zone: z.idx, type: 'drop' });
      if (bomb) blasts.push({ x: p.x, z: p.z, r: BOMB_R, t0: landAt, at: explodeAt, kind: 'drum', y: surf });
      drops.push({
        x: p.x, z: p.z, s, kind, vy, surf, restY,
        endAt: bomb ? explodeAt : null,
        radius: s * 0.85,
        t0: t, fallAt, landAt,
        state: 'wait', warn: null, mesh: null,
        seed: hash(seed, 9000 + (++dropSeq)),
      });
      spawned += 1;
    }
    return spawned > 0;
  }

  function startCollapse(z, t) {
    const living = z.buildings.filter((b) => !b.collapsed && !b.pending);
    if (!living.length) return false;
    const b = living[z.rng.int(0, living.length - 1)];
    b.pending = true;
    b.pendingAt = t;
    b.telegraph = Math.max(1.1, 1.5 - difficulty(t) * 0.3);
    // Blast reaches this far beyond the footprint: ~2.7 m (1 floor) → ~5.3 m (3 floors)
    b.blastReach = Math.min(5.5, 1.5 + b.height * 0.45);
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
    spawnDrops(z, t + b.telegraph * 0.4, (1 + (difficulty(t) > 0.5 ? 1 : 0)) * (1 + Math.round(ramp(t))), b.front);
    rubbleLog.push({
      x0: fp.x0 + 0.15, x1: fp.x1 - 0.15, z0: fp.z0 + 0.15, z1: fp.z1 - 0.15,
      a: (fp.x1 - fp.x0 - 0.3) * (fp.z1 - fp.z0 - 0.3),
      T: t + b.telegraph, zone: z.idx,
    });
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
    const n = Math.round((b.collapseType === 'pancake' ? 9 : 6) * (1 + ramp(T)));
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
      const tl = T + tLand;
      // rubble that would land on a crack or another object shatters instead of settling
      const settles = isOpen(lx, lz, 0, tl)
        && !activeHoles(tl).some((h) => Math.hypot(h.x - lx, h.z - lz) < h.r + s * 0.6)
        && !dropLog.some((d) => tl >= d.t0 - 0.5 && tl < d.end && Math.hypot(d.x - lx, d.z - lz) < (d.r ?? 1) + s * 0.6);
      const c = {
        s, p0, v, tLand, T, lx, lz, restY, settles,
        rot: new THREE.Euler(vr.range(0, 3), vr.range(0, 6), vr.range(0, 3)),
        spin: new THREE.Vector3(vr.range(-4, 4), vr.range(-4, 4), vr.range(-4, 4)),
        mesh: null, collider: null, hitDone: false,
      };
      if (settles) dropLog.push({ x: lx, z: lz, r: s * 0.6, t0: T, land: T + tLand, end: T + tLand + OBJECT_LIFE, type: 'chunk' });
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
    for (let tries = 0; tries < 16; tries++) {
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
      if (travel < 5) continue;
      const stopAt = goAt + travel / speed;
      const end = pos(s0 + dir * travel);
      const id = ++carSeq;
      dropLog.push({ x: end.x, z: end.z, r: CAR_HALF_L, t0: t, land: stopAt, end: stopAt + OBJECT_LIFE, zone: z.idx, type: 'car' });
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

  /* ---------------- fire + explosions ---------------- */
  const fireLog = []; // { id, x, z, r, igniteAt, zone, warned }
  const fireEnts = [];
  const blasts = [];  // { x, z, r, t0, at, kind, y, sign?, ring?, done? }
  let fireSeq = 0;
  const fx = createHazardFx(world);

  /** A point on the street side of house `b`, `out` metres beyond its front. */
  function frontPoint(b, rng, out) {
    const fp = b.footprint;
    const dir = FACE_DIR[b.face] || [0, 1];
    const cx = (fp.x0 + fp.x1) / 2;
    const cz = (fp.z0 + fp.z1) / 2;
    const halfDepth = dir[0] ? (fp.x1 - fp.x0) / 2 : (fp.z1 - fp.z0) / 2;
    const halfWidth = dir[0] ? (fp.z1 - fp.z0) / 2 : (fp.x1 - fp.x0) / 2;
    const side = rng.range(-halfWidth * 0.7, halfWidth * 0.7);
    return {
      x: cx + dir[0] * (halfDepth + out) + dir[1] * side,
      z: cz + dir[1] * (halfDepth + out) + dir[0] * side,
    };
  }

  /**
   * Fire at a house front or on its rubble; never goes out. `at` = forced spot
   * + ignite time (a gas blast lighting its own fire).
   */
  function spawnFire(z, t, at = null) {
    const cap = Math.round(FIRE_CAP_MIN + (FIRE_CAP_MAX - FIRE_CAP_MIN) * ramp(t));
    if (!at && fireLog.filter((f) => f.zone === z.idx).length >= cap) return false;
    for (let tries = 0; tries < 8; tries++) {
      let p;
      const r = z.rng.range(1.1, 1.9);
      const heaps = rubbleLog.filter((h) => h.zone === z.idx && t >= h.T);
      const onHeap = !at && heaps.length && z.rng.chance(0.35);
      if (at) {
        p = { x: at.x, z: at.z };
      } else if (onHeap) {
        const h = heaps[z.rng.int(0, heaps.length - 1)];
        p = { x: z.rng.range(h.x0, h.x1), z: z.rng.range(h.z0, h.z1) };
      } else {
        if (!z.buildings.length) return false;
        const b = z.buildings[z.rng.int(0, z.buildings.length - 1)];
        p = frontPoint(b, z.rng, z.rng.range(0.2, 1.1));
      }
      if (fireLog.some((f) => Math.hypot(f.x - p.x, f.z - p.z) < f.r + r + 0.6)) continue;
      const id = ++fireSeq;
      const entry = { id, x: p.x, z: p.z, r, igniteAt: at ? at.time : t + FIRE_TELEGRAPH, t0: t, zone: z.idx, warned: !at };
      fireLog.push(entry);
      fireEnts.push({ ...entry, fx: null, sign: null, ring: null });
      return true;
    }
    return false;
  }

  /** Gas leak at a house front → explosion after the telegraph; may start a fire. */
  function spawnGasBlast(z, t) {
    if (!z.buildings.length) return false;
    const b = z.buildings[z.rng.int(0, z.buildings.length - 1)];
    const p = frontPoint(b, z.rng, z.rng.range(0.3, 1.4));
    const r = z.rng.range(2.6, 3.4);
    const at = t + BLAST_TELEGRAPH;
    const ignite = z.rng.chance(0.5);
    blasts.push({ x: p.x, z: p.z, r, t0: t, at, kind: 'gas', y: groundAt(p.x, p.z, t) });
    if (ignite) spawnFire(z, t, { x: p.x, z: p.z, time: at });
    return true;
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
    if (roll < 0.74) return (t > 40 && (spawnCar(z, t) || spawnCar(z, t))) || spawnDrops(z, t, 1);
    // half the collapse share goes to debris instead, so the town lasts a 10-min round
    return (t > 25 && z.rng.chance(0.5) && startCollapse(z, t)) || spawnDrops(z, t, 1);
  }

  function fireDueEvents() {
    for (let guard = 0; guard < 6000; guard++) {
      let z = null;
      for (const zz of zones) if (!z || zz.next < z.next) z = zz;
      if (!z || z.next > elapsed) break;
      const t = z.next;
      z.index += 1;
      const d = difficulty(t);
      const k = ramp(t);
      fireOne(z, t);
      if (d > 0.25 && z.rng.chance(0.42 + d * 0.28)) fireOne(z, t);
      // Ground keeps splitting: extra narrow cracks, more often as it heats up
      if (z.rng.chance(0.12 + k * 0.55)) spawnFissure(z, t, 'crack');
      // Fires at houses (never put out) and gas explosions at house fronts
      if (t > 30 && z.rng.chance(0.04 + k * 0.12)) spawnFire(z, t);
      if (t > 20 && z.rng.chance(0.03 + k * 0.1)) spawnGasBlast(z, t);
      // Debris rain: extra falling objects, more as the intensity climbs
      if (z.rng.chance(0.2 + k * 0.6)) spawnDrops(z, t, 1 + (k > 0.6 && z.rng.chance(0.5) ? 1 : 0));
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
      surf.push(surfVis(x + p.x * 1.002, z + p.z * 1.002));
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
    // walls + floor + floor rubble share one vertex-coloured mesh
    const pitParts = [{ geometry: geo }];

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
    pitParts.push(part(floorGeo, 0x120d0e, 0, -PIT_DEPTH + 0.02, 0));

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
      const bx = part(new THREE.BoxGeometry(sz, sz * 0.6, sz * 0.8), 0x2b2325);
      bx.geometry.applyMatrix4(m);
      pitParts.push(bx);
    }
    void deep;
    const pitMesh = new THREE.Mesh(bake(pitParts), pitMat);
    pitMesh.castShadow = true;
    pitMesh.receiveShadow = true;
    g.add(pitMesh);

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
    // road + sidewalk crust slabs in one vertex-coloured mesh
    const crustParts = [];
    for (const [list, hex] of [[crust.road, PAL.road], [crust.walk, PAL.sidewalk]]) {
      for (const c of list) {
        const q = part(c.geometry, hex);
        q.geometry.applyMatrix4(c.matrix);
        crustParts.push(q);
      }
    }
    if (crustParts.length) {
      const mesh = new THREE.Mesh(bake(crustParts), crustVC);
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
        const y0 = surfVis(f.x + cx, f.z + cz) + 0.012;
        const y1 = surfVis(f.x + nx2, f.z + nz2) + 0.012;
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
    const lift = (vx, vz) => surfVis(x + vx, z + vz) + 0.02;

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
            if (!isOpen(qx, qz, 0.3, elapsed)) break;
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
      world.detachLoose?.(lp, !silent);
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
    drum: cel({ color: 0xc8302a, bands: 3, tint: 0x7a4060 }),
    drumBand: cel({ color: PAL.yellow, bands: 2, tint: 0x8f7050 }),
  };

  /**
   * GPU-instanced pool: hundreds of long-lived objects in one draw call.
   * Each user keeps a proxy Object3D (animated as before); its inner node's
   * matrixWorld is copied into the instance slot every frame.
   */
  function makeInstancer(geo, mat, cap) {
    const im = new THREE.InstancedMesh(geo, mat, cap);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = true;
    im.receiveShadow = true;
    world.add(im);
    const free = [];
    let top = 0;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    return {
      alloc() {
        const i = free.length ? free.pop() : (top < cap ? top++ : -1);
        if (i >= 0) im.count = Math.max(im.count, i + 1);
        return i;
      },
      set(i, m) {
        if (i < 0) return;
        im.setMatrixAt(i, m);
        im.instanceMatrix.needsUpdate = true;
      },
      release(i) {
        if (i < 0) return;
        im.setMatrixAt(i, zero);
        im.instanceMatrix.needsUpdate = true;
        free.push(i);
      },
      reset() {
        for (let i = 0; i < top; i++) im.setMatrixAt(i, zero);
        im.instanceMatrix.needsUpdate = true;
        free.length = 0;
        top = 0;
        im.count = 0;
      },
    };
  }

  // One vertex-coloured mesh per fallen object (they persist 90 s and there
  // can be hundreds — a mesh per part blew the draw-call budget).
  const dropVC = cel({ color: 0xffffff, vertexColors: true, bands: 3, tint: 0x4a4038 });
  const _dc = new THREE.Color();
  function part(geo, hex, x = 0, y = 0, z = 0) {
    geo.translate(x, y, z);
    _dc.setHex(hex);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) col.set([_dc.r, _dc.g, _dc.b], i * 3);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return { geometry: geo };
  }

  /** Unit-size (s = 1) geometry per drop kind; baked once. */
  function dropGeometry(kind) {
    const s = 1;
    const B = (w, h, dd, hex, x, y, z) => part(new THREE.BoxGeometry(w, h, dd), hex, x, y, z);
    const C = (r, h, hex, y) => part(new THREE.CylinderGeometry(r, r, h, 14).toNonIndexed(), hex, 0, y, 0);
    let parts;
    if (kind === 0) {
      parts = [B(s, s * 0.75, s * 0.85, PAL.concreteDark), B(s * 0.5, s * 0.35, s * 0.5, PAL.rubble, s * 0.2, s * 0.45, 0)];
    } else if (kind === 1) {
      // air-con unit
      parts = [B(s * 1.2, s * 0.75, s * 0.5, PAL.wallWhite), B(s * 0.5, s * 0.5, 0.04, PAL.metalDark, -s * 0.22, 0, s * 0.26)];
    } else if (kind === 2) {
      // roof tile stack
      parts = [0, 1, 2, 3].map((i) => B(s * 1.1, s * 0.12, s * 0.7, PAL.roofSlate, 0, i * s * 0.14 - s * 0.2, (i % 2) * 0.05));
    } else if (kind === 4) {
      // hazard drum — blows up after landing
      parts = [C(s * 0.42, s, 0xc8302a, 0), C(s * 0.44, s * 0.1, PAL.yellow, -0.25 * s), C(s * 0.44, s * 0.1, PAL.yellow, 0.25 * s)];
    } else {
      // planter pot
      parts = [B(s * 0.8, s * 0.6, s * 0.8, PAL.clay), B(s * 0.65, s * 0.4, s * 0.65, PAL.leaf, 0, s * 0.45, 0)];
    }
    const geos = parts.map((q) => (q.geometry.index ? q.geometry.toNonIndexed() : q.geometry));
    return bake(geos.map((geometry) => ({ geometry })));
  }
  const dropInst = [0, 1, 2, 3, 4].map((k) => makeInstancer(dropGeometry(k), dropVC, 700));
  const chunkInst = makeInstancer(new THREE.BoxGeometry(1, 1, 1), rubbleMat, 1600);

  /** Proxy transform for an instanced drop (outer = animated, inner = size). */
  function buildDropMesh(d) {
    const g = new THREE.Object3D();
    const inner = new THREE.Object3D();
    inner.scale.setScalar(d.s);
    g.add(inner);
    d.inner = inner;
    d.slot = dropInst[d.kind].alloc();
    const vr = rngKit(d.seed);
    g.rotation.set(vr.range(0, 1), vr.range(0, 6), vr.range(0, 1));
    d.spin = new THREE.Vector3(vr.range(-5, 5), vr.range(-3, 3), vr.range(-5, 5));
    return g;
  }

  function syncInstance(inst, slot, proxy, inner) {
    if (slot < 0 || !proxy) return;
    proxy.updateMatrixWorld(true);
    inst.set(slot, inner.matrixWorld);
  }

  function releaseDrop(d) {
    if (d.slot != null && d.slot >= 0) dropInst[d.kind].release(d.slot);
    d.slot = -1;
    d.mesh = null;
  }

  function releaseChunk(c) {
    if (c.slot != null && c.slot >= 0) chunkInst.release(c.slot);
    c.slot = -1;
    c.mesh = null;
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
    // Low walkable heap (no wall): you can climb on it — and hazards follow you there
    world.add(makeRubble(fp, b.height, b.collapseSeed || 1));
    world.platforms.push({
      x0: fp.x0 + 0.15, x1: fp.x1 - 0.15, z0: fp.z0 + 0.15, z1: fp.z1 - 0.15,
      top: RUBBLE_TOP, rubble: true,
    });
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
    // Blast: everyone inside the telegraphed radius is hit and thrown outward
    world.collapseZones.push({
      kind: 'blastRect', x0: fp.x0, x1: fp.x1, z0: fp.z0, z1: fp.z1, cx, cz,
      r: b.blastReach || 3, life: 0.3, reason: 'collapse',
    });
    world.juice?.burstDust(cx, b.height * 0.4, cz, 28, 1.6);
    world.juice?.impactRing(cx, cz, PAL.red);
    notify(cx, cz, null, 0.85);
  }

  /** Rounded rectangle (footprint grown by `r`) as a THREE.Shape in local x / -z. */
  function roundedRect(hw, hd, r, shape = new THREE.Shape()) {
    const x0 = -hw - r, x1 = hw + r, y0 = -hd - r, y1 = hd + r;
    shape.moveTo(x0 + r, y0);
    shape.lineTo(x1 - r, y0);
    shape.absarc(x1 - r, y0 + r, r, -Math.PI / 2, 0, false);
    shape.lineTo(x1, y1 - r);
    shape.absarc(x1 - r, y1 - r, r, 0, Math.PI / 2, false);
    shape.lineTo(x0 + r, y1);
    shape.absarc(x0 + r, y1 - r, r, Math.PI / 2, Math.PI, false);
    shape.lineTo(x0, y0 + r);
    shape.absarc(x0 + r, y0 + r, r, Math.PI, Math.PI * 1.5, false);
    return shape;
  }

  /** Red zone around the house: the collapse hits everyone inside it. */
  function buildBlastWarn(b) {
    const fp = b.footprint;
    const cx = (fp.x0 + fp.x1) / 2;
    const cz = (fp.z0 + fp.z1) / 2;
    const hw = (fp.x1 - fp.x0) / 2;
    const hd = (fp.z1 - fp.z0) / 2;
    const R = b.blastReach || 3;
    const g = new THREE.Group();
    g.position.set(cx, 0.17, cz);
    const flat = (geo) => { geo.rotateX(-Math.PI / 2); return geo; };
    const fill = new THREE.Mesh(flat(new THREE.ShapeGeometry(roundedRect(hw, hd, R), 6)), decal(PAL.danger, 0.1));
    const band = (w) => {
      const sh = roundedRect(hw, hd, R);
      sh.holes.push(roundedRect(hw, hd, R - w));
      return flat(new THREE.ShapeGeometry(sh, 6));
    };
    const edge = new THREE.Mesh(band(0.22), decal(PAL.danger, 0.8));
    // closing ring: starts well outside and shrinks onto the edge at collapse
    const closing = new THREE.Mesh(band(0.18), decal(PAL.danger, 0.55));
    for (const m of [fill, edge, closing]) {
      m.renderOrder = 4;
      g.add(m);
    }
    edge.position.y = 0.004;
    closing.position.y = 0.006;
    g.userData = { fill, edge, closing };
    world.add(g);
    return g;
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
        disposeGroup(b.blastWarn);
        b.blastWarn = null;
        collapseBuilding(b, age - b.telegraph > STALE);
        continue;
      }
      if (age < 0) continue;
      if (!b.blastWarn) b.blastWarn = buildBlastWarn(b);
      {
        const u = Math.min(1, age / b.telegraph);
        const ud = b.blastWarn.userData;
        ud.fill.material.opacity = 0.08 + 0.22 * u;
        ud.edge.material.opacity = 0.5 + 0.4 * Math.sin(elapsed * 16);
        const k = 1.35 - 0.35 * u; // closing ring lands on the blast edge at collapse
        ud.closing.scale.set(k, 1, k);
      }
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
    updateFires(dt, player);
    updateBlasts(dt, player);
    for (const d of drops) if (d.mesh) syncInstance(dropInst[d.kind], d.slot, d.mesh, d.inner);
    for (const c of debris) if (c.mesh) syncInstance(chunkInst, c.slot, c.mesh, c.inner);
    fx.update(elapsed, dt);
    world.flushBlocks?.();
  }

  /** Solid AABB for a settled object (drop or rubble chunk). */
  function addSolid(owner, x, z, half, top = 1.6) {
    if (owner.alongX !== undefined && !half) {
      const hx = owner.alongX ? CAR_HALF_L : CAR_HALF_W;
      const hz = owner.alongX ? CAR_HALF_W : CAR_HALF_L;
      world.collide(x - hx, z - hz, x + hx, z + hz, 1.8, undefined, owner);
      owner.solid = true;
      return;
    }
    world.collide(x - half, z - half, x + half, z + half, top, undefined, owner);
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
      const endAt = d.endAt ?? (d.landAt + OBJECT_LIFE);
      if (elapsed > endAt) {
        disposeGroup(d.warn);
        releaseDrop(d);
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
          addSolid(d, d.x, d.z, d.s * 0.55, d.restY + d.s * 0.42);
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
          addSolid(d, d.x, d.z, d.s * 0.55, d.restY + d.s * 0.42);
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
        if (d.kind === 4) {
          // fuse: the drum shudders faster and faster
          const left = endAt - elapsed;
          d.mesh.position.y = d.restY + Math.abs(Math.sin(elapsed * (30 + 40 / Math.max(0.2, left)))) * 0.05;
        } else {
          // sink away during the last second
          const rem = endAt - elapsed;
          if (rem < 1) d.mesh.position.y = Math.min(d.mesh.position.y, d.restY - (1 - rem) * 1.0);
          if (rem < 1) removeSolid(d);
        }
      }
    }
  }

  function buildCarWarn(c) {
    const g = new THREE.Group();
    const len = c.travel + CAR_HALF_L * 2;
    const w = (CAR_HALF_W + CAR_HIT_PAD) * 2;
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
    const parts = c.kind === 0 ? makeSedan(o) : c.kind === 1 ? makeVan(o) : makeKeiTruck(o);
    // merge the car's parts per material (wrecks linger 90 s)
    parts.position.set(0, 0, 0);
    parts.rotation.set(0, 0, 0);
    const mesh = new THREE.Group();
    mergeStatic([parts], mesh);
    mesh.position.set(o.x, o.y, o.z);
    mesh.rotation.y = ry;
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
        const prevD = c.prevD ?? 0;
        c.prevD = d;
        const s = c.s0 + c.dir * d;
        const x = c.alongX ? s : c.lateral;
        const z = c.alongX ? c.lateral : s;
        c.mesh.position.set(x, 0.1, z);
        // fishtail as it slides down the street
        if (c.baseRy == null) c.baseRy = c.mesh.rotation.y;
        c.mesh.rotation.y = c.baseRy + Math.sin(elapsed * 9 + c.id) * 0.13;
        if (player?.alive) {
          // Swept test over everything the car covered since last frame, so a
          // fast car (or a slow frame) can't skip past you
          const ps = c.alongX ? player.pos.x : player.pos.z;
          const across = c.alongX ? player.pos.z - c.lateral : player.pos.x - c.lateral;
          const sA = c.s0 + c.dir * prevD;
          const lo = Math.min(sA, s) - CAR_HALF_L - 0.3;
          const hi = Math.max(sA, s) + CAR_HALF_L + 0.3;
          if (ps > lo && ps < hi && Math.abs(across) < CAR_HALF_W + CAR_HIT_PAD) {
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
          world.collapseZones.push({ kind: 'blast', cx: c.x1, cz: c.z1, r: CAR_CRASH_R, life: 0.2, reason: 'car' });
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

  function warnRing(x, z, r, color, y) {
    const g = new THREE.Group();
    g.position.set(x, y + 0.03, z);
    const fill = new THREE.Mesh(new THREE.CircleGeometry(r, 40), decal(color, 0.12));
    const edge = new THREE.Mesh(new THREE.RingGeometry(r * 0.93, r, 48), decal(color, 0.8));
    const closing = new THREE.Mesh(new THREE.RingGeometry(r * 0.92, r, 48), decal(color, 0.55));
    for (const m of [fill, edge, closing]) { m.rotation.x = -Math.PI / 2; m.renderOrder = 4; g.add(m); }
    edge.position.y = 0.004;
    closing.position.y = 0.006;
    g.userData = { fill, edge, closing };
    world.add(g);
    return g;
  }

  function animateRing(g, u) {
    const ud = g.userData;
    ud.fill.material.opacity = 0.1 + 0.25 * u;
    ud.edge.material.opacity = 0.5 + 0.4 * Math.sin(elapsed * 16);
    const k = 1.8 - 0.8 * u;
    ud.closing.scale.set(k, k, 1);
  }

  function fireRadius(f) {
    return f.r * (1 + Math.min(0.45, (elapsed - f.igniteAt) / 260));
  }

  function updateFires(dt, player) {
    let nearest = Infinity;
    const lit = [];
    for (const f of fireEnts) {
      if (elapsed < f.t0) continue;
      if (!f.fx) {
        const gy = surfVis(f.x, f.z);
        f.fx = fx.addFire(f.x, f.z, f.r, f.igniteAt, rngKit(hash(seed, 13000 + f.id)), gy);
        f.gy = gy;
      }
      if (elapsed < f.igniteAt) {
        if (f.warned && !f.sign && elapsed < f.igniteAt - 0.05) {
          f.sign = fx.makeSign('fire', f.x, f.z, f.gy + 2.4);
          f.ring = warnRing(f.x, f.z, f.r, PAL.orange, f.gy);
          notify(f.x, f.z, 'Fire!', 0.05);
        }
        if (f.sign) {
          fx.updateSign(f.sign, elapsed);
          animateRing(f.ring, Math.min(1, (elapsed - f.t0) / FIRE_TELEGRAPH));
        }
        continue;
      }
      if (f.sign || f.ring) {
        fx.removeSign(f.sign);
        disposeGroup(f.ring);
        f.sign = null;
        f.ring = null;
      }
      if (!f.lit) {
        f.lit = true;
        if (elapsed - f.igniteAt < STALE) sfx('fire_ignite', f.x, f.z, 1);
      }
      lit.push({ x: f.x, z: f.z, r: fireRadius(f) });
      if (player?.pos) {
        const dx = player.pos.x - f.x;
        const dz = player.pos.z - f.z;
        const d = Math.hypot(dx, dz);
        nearest = Math.min(nearest, d - fireRadius(f));
        if (player.alive && d < fireRadius(f) * 0.85 && player.pos.y < f.gy + 1.6) {
          const l = d || 1;
          player.takeHit('fire', { kx: (dx / l) * 6, kz: (dz / l) * 6, shake: 0.9 });
        }
      }
    }
    world.fireMarks = lit;
    world.onFireNear?.(nearest);
  }

  function updateBlasts(dt, player) {
    for (let i = blasts.length - 1; i >= 0; i--) {
      const b = blasts[i];
      if (elapsed < b.t0) continue;
      if (elapsed < b.at) {
        if (!b.sign && elapsed < b.at - 0.05) {
          b.sign = fx.makeSign('blast', b.x, b.z, (b.y || 0.1) + 2.2);
          b.ring = warnRing(b.x, b.z, b.r, PAL.danger, b.y || 0.1);
          notify(b.x, b.z, b.kind === 'gas' ? 'Gas leak — explosion!' : 'Hazard drum — it will blow!', 0.08);
        }
        if (b.sign) {
          fx.updateSign(b.sign, elapsed);
          const span = b.kind === 'gas' ? BLAST_TELEGRAPH : BOMB_FUSE;
          animateRing(b.ring, Math.min(1, 1 - (b.at - elapsed) / span));
        }
        continue;
      }
      fx.removeSign(b.sign);
      disposeGroup(b.ring);
      blasts.splice(i, 1);
      if (elapsed - b.at > STALE) continue; // long past (late join): no boom
      fx.fireball(b.x, b.z, b.r, b.y || 0.1);
      world.juice?.burstDust(b.x, (b.y || 0.1) + 0.6, b.z, 26, 1.6);
      world.juice?.impactRing(b.x, b.z, PAL.orange);
      notify(b.x, b.z, null, 0.95);
      sfx('explosion', b.x, b.z, 1);
      world.collapseZones.push({ kind: 'blast', cx: b.x, cz: b.z, r: b.r, life: 0.22, reason: 'explosion' });
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
        releaseChunk(c);
        removeSolid(c);
        debris.splice(i, 1);
        continue;
      }
      if (!c.mesh) {
        c.mesh = new THREE.Object3D();
        c.inner = new THREE.Object3D();
        c.inner.scale.set(c.s, c.s * 0.7, c.s * 0.8);
        c.mesh.add(c.inner);
        c.slot = chunkInst.alloc();
        c.mesh.rotation.copy(c.rot);
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
        if (c.s > 0.42) addSolid(c, c.lx, c.lz, c.s * 0.45, c.restY + c.s * 0.35);
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
      if (z.kind === 'blastRect') {
        // distance from the footprint rectangle
        const qx = Math.max(z.x0, Math.min(z.x1, pos.x));
        const qz = Math.max(z.z0, Math.min(z.z1, pos.z));
        const d = Math.hypot(pos.x - qx, pos.z - qz);
        if (player?.alive && d < z.r) {
          const dx = pos.x - z.cx;
          const dz = pos.z - z.cz;
          const l = Math.hypot(dx, dz) || 1;
          const push = 7 * (1 - d / z.r) + 3;
          player.takeHit(z.reason || 'collapse', { kx: (dx / l) * push, kz: (dz / l) * push, shake: 1.2 });
        }
      } else if (z.kind === 'blast') {
        const dx = pos.x - z.cx;
        const dz = pos.z - z.cz;
        const d = Math.hypot(dx, dz);
        if (player?.alive && d < z.r) {
          const push = 7 * (1 - d / z.r) + 3;
          player.takeHit(z.reason || 'collapse', { kx: (dx / (d || 1)) * push, kz: (dz / (d || 1)) * push, shake: 1.2 });
        }
      } else if (player?.alive && pos.x > z.x0 && pos.x < z.x1 && pos.z > z.z0 && pos.z < z.z1) {
        player.takeHit(z.kind === 'collapse' ? 'collapse' : 'debris', { shake: 1.1 });
      }
      if (z.life <= 0) world.collapseZones.splice(i, 1);
    }
  }

  function reset() {
    for (const f of fissures) { disposeGroup(f.warn); disposeGroup(f.pit); }
    for (const d of drops) { disposeGroup(d.warn); releaseDrop(d); removeSolid(d); }
    for (const d of debris) { releaseChunk(d); removeSolid(d); }
    for (const inst of [...dropInst, chunkInst]) inst.reset();
    for (const c of cars) { disposeGroup(c.warn); if (c.mesh) world.root.remove(c.mesh); removeSolid(c); }
    for (const b of world.buildings) { disposeGroup(b.blastWarn); b.blastWarn = null; }
    for (const f of fireEnts) { fx.removeSign(f.sign); disposeGroup(f.ring); }
    for (const b of blasts) { fx.removeSign(b.sign); disposeGroup(b.ring); }
    fireEnts.length = 0;
    blasts.length = 0;
    fx.reset();
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
    /** Debug: fire / gas blast at the house nearest (x, z). */
    window.__aftershockSpawnFire = (x = listener.x, z = listener.z) => {
      const zone = zones.find((zz) => zz.inRegion(x, z)) || zones[0];
      return spawnFire({ ...zone, rng: debugRng, buildings: nearestBuildings(x, z) }, elapsed);
    };
    window.__aftershockSpawnBlast = (x = listener.x, z = listener.z) => {
      const zone = zones.find((zz) => zz.inRegion(x, z)) || zones[0];
      return spawnGasBlast({ ...zone, rng: debugRng, buildings: nearestBuildings(x, z) }, elapsed);
    };
    function nearestBuildings(x, z) {
      return [...world.buildings].sort((a, b) => {
        const da = Math.hypot((a.footprint.x0 + a.footprint.x1) / 2 - x, (a.footprint.z0 + a.footprint.z1) / 2 - z);
        const db = Math.hypot((b.footprint.x0 + b.footprint.x1) / 2 - x, (b.footprint.z0 + b.footprint.z1) / 2 - z);
        return da - db;
      }).slice(0, 1);
    }
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
    /** Current quake intensity on the shared clock + shindo (1–7) for the HUD. */
    get intensity() { return intensity(elapsed); },
    get shindo() { return shindo(elapsed); },
    get fireCount() { return fireEnts.filter((f) => f.lit).length; },
    get blastCount() { return blasts.length; },
    /** Debug: where hazards landed (event log) and the rubble heaps. */
    get debugSpots() {
      return {
        holes: holeLog.map((h) => [h.x, h.z, h.t0]),
        drops: dropLog.map((d) => [d.x, d.z, d.t0, d.end, d.r ?? 1, d.land ?? d.t0, d.type]),
        holeSpans: holeLog.map((h) => [h.x, h.z, h.t0, h.expiresAt, h.r]),
        rubble: rubbleLog.map((r) => [r.x0, r.x1, r.z0, r.z1, r.T]),
      };
    },
    get cars() { return cars.map((c) => ({ x0: c.x0, z0: c.z0, x1: c.x1, z1: c.z1, state: c.state, travel: c.travel })); },
  };
}
