import * as THREE from 'three';
import { box, mergeStatic } from '../core/util.js';
import { cel } from '../core/toon.js';
import { PAL } from '../core/palette.js';
import {
  buildStreet, addLane, MAP, ROADS, PLAZA, WALK_W, FRONT_APRON, LOT_TOP,
  corridorHalf, subtractIntervals,
} from './street.js';
import { makeHouse, makeShop } from './buildings.js';
import { buildStreetProps } from './props.js';
import { createDisaster } from './disaster.js';
import { createJuice } from './juice.js';

export const WORLD_SEED = 20241019;

/**
 * @param {THREE.Scene} scene
 * @param {{ seed?: number }} [opts] seed drives the hazard timeline only;
 *   the town layout is fixed so every client builds the same streets.
 */
export function buildWorld(scene, opts = {}) {
  const root = new THREE.Group();
  root.name = 'world';
  scene.add(root);

  const colliders = [];
  const platforms = [];
  const cuts = [];
  const holes = [];
  const collapseZones = [];
  const buildings = [];
  const updaters = [];

  const ctx = {
    scene,
    root,
    colliders,
    platforms,
    cuts,
    add: (obj) => { root.add(obj); return obj; },
    collide: (x0, z0, x1, z1, top, bottom, ref) => {
      colliders.push({
        x0: Math.min(x0, x1), x1: Math.max(x0, x1),
        z0: Math.min(z0, z1), z1: Math.max(z0, z1),
        top, bottom, ref,
      });
    },
    platform: (p) => platforms.push(p),
    cut: (c) => cuts.push(c),
  };

  buildStreet(ctx);
  placeBuildings(ctx, buildings);
  buildStreetProps(ctx);
  // Draw-call diet: everything that never moves or disappears becomes one
  // mesh per material; collapsible buildings + loose props stay separate.
  const keep = new Set((ctx.looseProps || []).map((l) => l.obj));
  const staticBatch = new THREE.Group();
  staticBatch.name = 'static';
  mergeStatic(root.children.filter((c) => !keep.has(c)), staticBatch);
  root.add(staticBatch);
  for (const lp of ctx.looseProps || []) {
    const holder = lp.obj;
    const kids = holder.children.slice();
    holder.updateMatrixWorld(true);
    mergeStatic(kids, holder);
  }
  for (const block of ctx.blocks) rebuildBlock(block, root);
  // Loose clutter is solid but must not stop fissures (it tumbles in instead)
  const staticColliders = colliders.filter((c) => !c.ref?.loose);
  const openRects = ctx.openRects;
  const avoid = ctx.avoid || [];

  const bounds = {
    x0: -MAP.half + 0.6,
    x1: MAP.half - 0.6,
    z0: -MAP.half + 0.6,
    z1: MAP.half - 0.6,
  };

  /**
   * Top of the paved surface at (x, z), ignoring holes and rubble heaps
   * (hazard placement adds rubble from its deterministic event log instead).
   */
  function surfaceAt(x, z) {
    let y = 0;
    for (const p of platforms) {
      if (p.rubble) continue;
      if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
      if (p.top > y) y = p.top;
    }
    return y;
  }

  function holeAt(x, z) {
    for (const h of holes) {
      if (h.contains(x, z)) return h;
    }
    return null;
  }

  function heightAt(x, z, fromY) {
    const h = holeAt(x, z);
    if (h) return h.bottom;
    for (const c of cuts) {
      if (c.skipHeight) continue;
      if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) return c.top ?? -2.5;
    }
    let y = 0;
    const feet = fromY ?? y;
    for (const p of platforms) {
      if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
      if (p.top > feet + 0.45) continue;
      if (p.top > y) y = p.top;
    }
    return y;
  }

  function inKillHole(x, z) {
    return !!holeAt(x, z);
  }

  /** Paved, open, not under anything solid — where hazards may land. */
  function isOpenGround(x, z, margin = 0.3) {
    if (Math.abs(x) > MAP.half - 1 || Math.abs(z) > MAP.half - 1) return false;
    let open = false;
    for (const r of openRects) {
      if (x >= r.x0 && x <= r.x1 && z >= r.z0 && z <= r.z1) { open = true; break; }
    }
    if (!open) return false;
    for (const c of staticColliders) {
      if (x > c.x0 - margin && x < c.x1 + margin && z > c.z0 - margin && z < c.z1 + margin) return false;
    }
    for (const a of avoid) {
      const dx = x - a.x;
      const dz = z - a.z;
      if (dx * dx + dz * dz < (a.r + margin) * (a.r + margin)) return false;
    }
    return true;
  }

  const world = {
    root,
    get colliders() { return colliders; },
    set colliders(v) { colliders.length = 0; colliders.push(...v); },
    platforms, cuts, holes, collapseZones, buildings, bounds,
    openRects, looseProps: ctx.looseProps || [],
    zones: makeZones(openRects, buildings, ctx.carriages),
    staticColliders,
    heightAt, surfaceAt, inKillHole, holeAt, isOpenGround,
    add: ctx.add, collide: ctx.collide, cut: ctx.cut,
    onQuake: null, onFlash: null, onSfx: null,
    /** Pull a house out of its block batch so it can animate on its own. */
    detachBuilding(b) {
      if (!b.block) { if (!b.group.parent) root.add(b.group); return; }
      b.block.dirty = true;
      root.add(b.group);
    },
    /** Rebuild any block batches invalidated this frame. */
    flushBlocks() {
      for (const block of ctx.blocks) if (block.dirty) rebuildBlock(block, root);
    },
  };

  world.juice = createJuice(world);
  world.disaster = createDisaster(world, { seed: opts.seed ?? WORLD_SEED });
  updaters.push((dt, player) => world.disaster.update(dt, player));
  updaters.push((dt) => world.juice.update(dt));
  world.updaters = updaters;

  return world;
}

/**
 * Hazard zones: the plaza plus four quadrants. Each runs its own
 * deterministic hazard clock, so density stays similar to the old
 * single-cross map wherever a player is standing.
 */
function makeZones(openRects, buildings, carriages) {
  const Z = PLAZA.half + 4;
  const H = MAP.half;
  const regions = [
    { name: 'plaza', x0: -Z, x1: Z, z0: -Z, z1: Z, exclude: null },
    { name: 'sw', x0: -H, x1: 0, z0: -H, z1: 0, exclude: Z },
    { name: 'se', x0: 0, x1: H, z0: -H, z1: 0, exclude: Z },
    { name: 'nw', x0: -H, x1: 0, z0: 0, z1: H, exclude: Z },
    { name: 'ne', x0: 0, x1: H, z0: 0, z1: H, exclude: Z },
  ];
  return regions.map((reg) => {
    const rects = [];
    let area = 0;
    for (const r of openRects) {
      const x0 = Math.max(r.x0, reg.x0);
      const x1 = Math.min(r.x1, reg.x1);
      const z0 = Math.max(r.z0, reg.z0);
      const z1 = Math.min(r.z1, reg.z1);
      if (x1 - x0 < 0.5 || z1 - z0 < 0.5) continue;
      const a = (x1 - x0) * (z1 - z0);
      rects.push({ x0, x1, z0, z1, a });
      area += a;
    }
    const inRegion = (x, z) => x >= reg.x0 && x <= reg.x1 && z >= reg.z0 && z <= reg.z1
      && !(reg.exclude && Math.abs(x) < reg.exclude && Math.abs(z) < reg.exclude);
    const zoneBuildings = buildings.filter((b) => {
      const cx = (b.footprint.x0 + b.footprint.x1) / 2;
      const cz = (b.footprint.z0 + b.footprint.z1) / 2;
      if (reg.name === 'plaza') return Math.abs(cx) < Z + 8 && Math.abs(cz) < Z + 8;
      return inRegion(cx, cz) && !(Math.abs(cx) < Z + 8 && Math.abs(cz) < Z + 8);
    });
    // Road stretches inside this zone (runaway-car lanes), in road-local terms
    const roads = [];
    for (const { road, rect } of carriages) {
      const x0 = Math.max(rect.x0, reg.x0);
      const x1 = Math.min(rect.x1, reg.x1);
      const z0 = Math.max(rect.z0, reg.z0);
      const z1 = Math.min(rect.z1, reg.z1);
      if (x1 - x0 < 0.5 || z1 - z0 < 0.5) continue;
      const lo = road.axis === 'x' ? x0 : z0;
      const hi = road.axis === 'x' ? x1 : z1;
      if (hi - lo > 10) roads.push({ road, lo, hi });
    }
    return { name: reg.name, rects, area, inRegion, buildings: zoneBuildings, roads };
  });
}

/* ------------------------------------------------------------------ *
 * Town blocks
 *
 * Each block between road corridors is split by a walkable 3 m back lane
 * (alternating E–W / N–S per block). Both halves carry a frontage row
 * facing the road and a back row facing the lane, so every block has four
 * rows of collapsible houses. Gaps between houses are sealed with low
 * walls; the lane is reachable only from its ends. Houses of a block are
 * batched into one mesh per material (see makeBlockBatch).
 * ------------------------------------------------------------------ */
const PARTY_GAP = 0.45;
const BIKE_GAP = 1.1;
const LANE_W = 3.0;
const SHOP_LABELS = ['角の店', 'たばこ', '米屋', '青空', '書店', '花屋', '八百屋', '銭湯', '喫茶', '薬局'];

function placeBuildings(ctx, buildings) {
  const H = MAP.half;
  const P = PLAZA.half;
  const corrX = ROADS.filter((r) => r.axis === 'z').map((r) => [r.c - corridorHalf(r), r.c + corridorHalf(r)]);
  const corrZ = ROADS.filter((r) => r.axis === 'x').map((r) => [r.c - corridorHalf(r), r.c + corridorHalf(r)]);
  const xs = subtractIntervals(-H, H, corrX);
  const zs = subtractIntervals(-H, H, corrZ);
  const wallMat = cel({ color: PAL.concreteMid, bands: 3, tint: 0x6a6288 });
  const AP = FRONT_APRON;
  let seedBase = 0;
  let shopIdx = 0;
  const blocks = [];
  ctx.blocks = blocks;

  const plazaClip = (lo, hi, crossLo, crossHi) => {
    if (crossHi < -P - 0.5 || crossLo > P + 0.5) return [[lo, hi]];
    return subtractIntervals(lo, hi, [[-P - 0.8, P + 0.8]]);
  };

  xs.forEach(([bx0, bx1], ix) => {
    zs.forEach(([bz0, bz1], iz) => {
      const block = { houses: [], batch: null, dirty: true };
      blocks.push(block);
      const laneAlongX = (ix + iz) % 2 === 0;
      // block-local frame: u runs along the lane, v across it
      const U = laneAlongX ? [bx0, bx1] : [bz0, bz1];
      const V = laneAlongX ? [bz0, bz1] : [bx0, bx1];
      const roadU0 = U[0] > -H + 0.1;
      const roadU1 = U[1] < H - 0.1;
      const roadV = [V[0] > -H + 0.1, V[1] < H - 0.1];
      const toW = (u, v) => (laneAlongX ? { x: u, z: v } : { x: v, z: u });
      const faceV = (sign) => (laneAlongX ? (sign < 0 ? 'z-' : 'z+') : (sign < 0 ? 'x-' : 'x+'));
      const vMid = (V[0] + V[1]) / 2;
      const laneV0 = vMid - LANE_W / 2;
      const laneV1 = vMid + LANE_W / 2;
      const half = laneV0 - V[0];

      // lane paving (ends meet the corridor sidewalks or the perimeter wall)
      const lr = laneAlongX
        ? { x0: U[0], x1: U[1], z0: laneV0, z1: laneV1 }
        : { x0: laneV0, x1: laneV1, z0: U[0], z1: U[1] };
      addLane(ctx, lr, laneAlongX);

      // rows run to the perimeter wall on map-edge ends so nothing hides behind them
      const uLo = U[0] + (roadU0 ? AP : 0.35);
      const uHi = U[1] - (roadU1 ? AP : 0.35);
      const rows = [];
      for (const side of [0, 1]) {
        const s = side === 0 ? -1 : 1; // outward direction in v
        const outer = V[side];
        const laneEdge = side === 0 ? laneV0 : laneV1;
        if (roadV[side]) {
          const F = Math.min(6, half * 0.55);
          const fFront = outer - s * AP;
          rows.push({ front: fFront, depth: F, face: faceV(s), sign: s, floors: [2, 2, 1, 3] });
          const bFront = laneEdge + s * 0.2;
          const bBack = fFront - s * (F + 0.1);
          const B = Math.abs(bBack - bFront);
          if (B >= 3) rows.push({ front: bFront, depth: B, face: faceV(-s), sign: -s, floors: [1, 2, 2] });
        } else {
          // map edge: one deep row from the lane to the wall
          const bFront = laneEdge + s * 0.2;
          const B = Math.abs(outer - s * 0.3 - bFront);
          rows.push({ front: bFront, depth: B, face: faceV(-s), sign: -s, floors: [2, 3, 2] });
        }
      }

      for (const row of rows) {
        const vc = row.front - row.sign * (row.depth / 2);
        for (const [lo, hi] of plazaClip(uLo, uHi, vc - row.depth / 2, vc + row.depth / 2)) {
          const houses = packSpan(lo, hi, seedBase, row.floors);
          seedBase += 97;
          houses.forEach((h, i) => {
            const p = toW(h.center, vc);
            const spec = {
              x: p.x, z: p.z, w: h.w, d: row.depth,
              face: row.face, seed: h.seed, wall: h.wall,
              floors: h.floors, collapseType: h.collapseType,
            };
            const asShop = (i === 0 || i === houses.length - 1) && houses.length > 2
              && (h.seed % 3 === 0) && row.depth <= 6.5;
            const built = asShop
              ? makeShop({ ...spec, label: SHOP_LABELS[shopIdx++ % SHOP_LABELS.length] })
              : makeHouse(spec);
            built.face = row.face;
            built.block = block;
            const fp = built.footprint;
            ctx.collide(fp.x0, fp.z0, fp.x1, fp.z1, fp.top, undefined, built);
            buildings.push(built);
            block.houses.push(built);
          });
          // Seal gaps between houses with a low garden wall on the frontage
          for (let i = 0; i < houses.length - 1; i++) {
            const a = houses[i].center + houses[i].w / 2;
            const b = houses[i + 1].center - houses[i + 1].w / 2;
            if (b - a < 0.2) continue;
            const mid = (a + b) / 2;
            const len = b - a + 0.1;
            const fv = row.front - row.sign * 0.35;
            const c = toW(mid, fv);
            const wall = laneAlongX
              ? box(len, 1.35, 0.18, wallMat, c.x, LOT_TOP + 0.67, c.z)
              : box(0.18, 1.35, len, wallMat, c.x, LOT_TOP + 0.67, c.z);
            wall.castShadow = true;
            wall.receiveShadow = true;
            ctx.add(wall);
            const p0 = toW(a, fv - 0.15);
            const p1 = toW(b, fv + 0.15);
            ctx.collide(p0.x, p0.z, p1.x, p1.z, 1.4);
          }
        }
      }
    });
  });
  void WALK_W;
}

/** Pack houses along a 1D span with party gaps + occasional bike gaps. */
function packSpan(from, to, seedBase, floorCycle = [2, 1, 2, 2]) {
  const houses = [];
  let cursor = from;
  let i = 0;
  while (cursor < to - 2.8) {
    let w = 3.4 + ((seedBase + i * 17) % 5) * 0.3; // 3.4–4.6 narrow machiya-style frontages
    if (cursor + w > to) {
      // stretch the last house to close the row rather than leave a hole
      w = to - cursor;
      if (w < 2.8) break;
    }
    const gap = (i % 5 === 3) ? BIKE_GAP : PARTY_GAP;
    houses.push({
      center: cursor + w / 2,
      w,
      seed: seedBase + i * 13,
      wall: (seedBase + i) % 8,
      floors: floorCycle[(seedBase / 97 + i) % floorCycle.length | 0],
      collapseType: i % 7 === 2 ? 'lean' : i % 7 === 5 ? 'pancake' : i % 7 === 0 ? 'facade' : undefined,
    });
    cursor += w + gap;
    i++;
  }
  // close the tail gap if the last house fell short of the span end
  const last = houses[houses.length - 1];
  if (last) {
    const end = last.center + last.w / 2;
    if (to - end > 0.05 && to - end < 2.8) {
      last.w += to - end;
      last.center = to - last.w / 2;
    }
  }
  return houses;
}

/**
 * Per-block batching: all standing, non-telegraphing houses of a block are
 * merged into one mesh per material. A house that starts to give way is
 * pulled out as its own group (so it can shake/lean) and the batch rebuilt.
 */
function rebuildBlock(block, root) {
  if (block.batch) {
    root.remove(block.batch);
    block.batch.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
  }
  const g = new THREE.Group();
  g.name = 'block';
  const standing = block.houses.filter((b) => !b.collapsed && !b.pending);
  if (standing.length) mergeStatic(standing.map((b) => b.group), g, { keep: true });
  root.add(g);
  block.batch = g;
  block.dirty = false;
}
