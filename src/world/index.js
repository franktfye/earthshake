import * as THREE from 'three';
import { rngKit, box } from '../core/util.js';
import { cel } from '../core/toon.js';
import { PAL } from '../core/palette.js';
import {
  buildStreet, groundY, MAP, ROAD_HALF, WALK_W, FRONT_APRON, frontCenter,
} from './street.js';
import { makeHouse, makeShop } from './buildings.js';
import { buildStreetProps } from './props.js';
import { createDisaster } from './disaster.js';
import { createJuice } from './juice.js';

export const WORLD_SEED = 20241019;

export function buildWorld(scene) {
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

  const rng = rngKit(WORLD_SEED);

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
  placeBuildings(ctx, buildings, rng);
  buildStreetProps(ctx);

  const bounds = {
    x0: -MAP.half + 0.6,
    x1: MAP.half - 0.6,
    z0: -MAP.half + 0.6,
    z1: MAP.half - 0.6,
  };

  function heightAt(x, z, fromY) {
    // Shape-matched fissure fall (circle/organic) — never AABB square
    for (const h of holes) {
      if (typeof h.contains === 'function') {
        if (h.contains(x, z)) return h.bottom ?? -2.5;
      } else if (x >= h.x0 && x <= h.x1 && z >= h.z0 && z <= h.z1) {
        return h.bottom ?? -2.5;
      }
    }
    for (const c of cuts) {
      if (c.skipHeight) continue;
      if (x >= c.x0 && x <= c.x1 && z >= c.z0 && z <= c.z1) return c.top ?? -2.5;
    }
    let y = groundY(z);
    const feet = fromY ?? y;
    for (const p of platforms) {
      if (x < p.x0 || x > p.x1 || z < p.z0 || z > p.z1) continue;
      if (p.top > feet + 0.45) continue;
      if (p.top > y) y = p.top;
    }
    return y;
  }

  function inKillHole(x, z) {
    for (const h of holes) {
      if (typeof h.contains === 'function') {
        if (h.contains(x, z)) return true;
        continue;
      }
      if (x >= h.x0 && x <= h.x1 && z >= h.z0 && z <= h.z1) return true;
    }
    return false;
  }

  const world = {
    root,
    get colliders() { return colliders; },
    set colliders(v) { colliders.length = 0; colliders.push(...v); },
    platforms, cuts, holes, collapseZones, buildings, bounds,
    heightAt, inKillHole,
    add: ctx.add, collide: ctx.collide, cut: ctx.cut,
    onQuake: null, onFlash: null,
  };

  world.juice = createJuice(world);
  world.disaster = createDisaster(world, { seed: WORLD_SEED });
  updaters.push((dt, player) => world.disaster.update(dt, player));
  updaters.push((dt) => world.juice.update(dt));
  world.updaters = updaters;

  return world;
}

/**
 * Spacing (sakura ichome / street numbers):
 * - ROAD_HALF 3.15, WALK_W 1.55 (unchanged from sakura)
 * - FRONT_APRON 0.25 m — building face sits just past sidewalk
 * - PARTY_GAP 0.55–0.85 m between neighbouring houses (sakura GAP_B ~0.75)
 * - BIKE_GAP ~2.4 m occasional shared yard (sakura GAP_A ~3.1, tightened)
 * - Narrow alleys 1.4 m between blocks
 */
const PARTY_GAP = 0.7;
const BIKE_GAP = 2.2;

function placeBuildings(ctx, buildings, rng) {
  const depth = 6.0;
  const fc = frontCenter(depth); // ~7.95

  // Continuous north frontage — almost party-wall packing, shops at corners
  placeRow(ctx, buildings, {
    axis: 'x',
    face: 'z-',
    z: fc,
    depth,
    // fill from -MAP.half+3 to -cornerClear and +cornerClear to +MAP.half-3
    spans: [
      packSpan(-31.5, -5.2, depth, 0),
      packSpan(5.2, 31.5, depth, 100),
    ],
  });

  placeRow(ctx, buildings, {
    axis: 'x',
    face: 'z+',
    z: -fc,
    depth,
    spans: [
      packSpan(-31.5, -5.2, depth, 200),
      packSpan(5.2, 31.5, depth, 300),
    ],
  });

  placeRow(ctx, buildings, {
    axis: 'z',
    face: 'x+',
    x: -fc,
    depth,
    spans: [
      packSpan(-31.0, -5.2, depth, 400),
      packSpan(5.2, 31.0, depth, 500),
    ],
  });

  placeRow(ctx, buildings, {
    axis: 'z',
    face: 'x-',
    x: fc,
    depth,
    spans: [
      packSpan(-31.0, -5.2, depth, 600),
      packSpan(5.2, 31.0, depth, 700),
    ],
  });

  // Second row (back lot) — tight behind first row, ~0.9 m alley
  const alley = 1.35;
  const backDepth = 5.4;
  const backFc = fc + depth / 2 + alley + backDepth / 2;

  placeRow(ctx, buildings, {
    axis: 'x', face: 'z-', z: backFc, depth: backDepth,
    spans: [packSpan(-30, -6, backDepth, 800), packSpan(6, 30, backDepth, 850)],
    floorsBias: 1,
  });
  placeRow(ctx, buildings, {
    axis: 'x', face: 'z+', z: -backFc, depth: backDepth,
    spans: [packSpan(-30, -6, backDepth, 900), packSpan(6, 30, backDepth, 950)],
    floorsBias: 1,
  });

  // Corner shops — plug the four intersection corners flush to curb
  const cornerShops = [
    { x: -8.6, z: fc - 0.15, w: 6.4, d: 6.2, face: 'z-', label: '角の店', wall: 0, collapseType: 'facade' },
    { x: 8.6, z: fc - 0.15, w: 6.4, d: 6.2, face: 'z-', label: 'たばこ', wall: 2 },
    { x: -8.6, z: -(fc - 0.15), w: 6.4, d: 6.2, face: 'z+', label: '米屋', wall: 1, collapseType: 'pancake' },
    { x: 8.6, z: -(fc - 0.15), w: 6.4, d: 6.2, face: 'z+', label: '青空', wall: 3 },
    { x: -(fc - 0.15), z: -8.4, w: 6.2, d: 5.8, face: 'x+', label: '書店', wall: 4 },
    { x: fc - 0.15, z: 8.4, w: 6.2, d: 5.8, face: 'x-', label: '花屋', wall: 5, collapseType: 'lean' },
  ];
  for (const s of cornerShops) {
    const built = makeShop(s);
    ctx.add(built.group);
    const fp = built.footprint;
    ctx.collide(fp.x0, fp.z0, fp.x1, fp.z1, fp.top, undefined, built);
    buildings.push(built);
  }

  // Garden / party walls in residual gaps (visual fill)
  fillPartyWalls(ctx, buildings);

  void rng;
}

/** Pack houses along a 1D span with party gaps + occasional bike gaps. */
function packSpan(from, to, depth, seedBase) {
  const houses = [];
  let cursor = from;
  let i = 0;
  while (cursor < to - 3.5) {
    const w = 4.8 + ((seedBase + i * 17) % 5) * 0.28; // 4.8–5.9
    if (cursor + w > to) break;
    const gap = (i % 5 === 3) ? BIKE_GAP : PARTY_GAP;
    houses.push({
      center: cursor + w / 2,
      w,
      d: depth,
      seed: seedBase + i * 13,
      wall: (seedBase + i) % 8,
      floors: (i % 4 === 1) ? 1 : 2,
      collapseType: i % 7 === 2 ? 'lean' : i % 7 === 5 ? 'pancake' : i % 7 === 0 ? 'facade' : undefined,
      gapAfter: gap,
    });
    cursor += w + gap;
    i++;
  }
  return houses;
}

function placeRow(ctx, buildings, { axis, face, x, z, depth, spans, floorsBias }) {
  for (const span of spans) {
    for (const h of span) {
      const spec = {
        w: h.w,
        d: h.d ?? depth,
        face,
        seed: h.seed,
        wall: h.wall,
        floors: floorsBias === 1 ? (h.floors === 2 ? 1 : h.floors) : h.floors,
        collapseType: h.collapseType,
      };
      if (axis === 'x') {
        spec.x = h.center;
        spec.z = z;
      } else {
        spec.z = h.center;
        spec.x = x;
        // for side rows authored as w along street: swap so width faces street correctly
        // makeHouse: w along local X, d along Z, then rotated by face
        // face x+/- : footprint uses d along X — keep w as street-front width by swapping
        const streetW = h.w;
        spec.w = h.d ?? depth;
        spec.d = streetW;
      }
      addHouse(ctx, buildings, spec);
    }
  }
}

function addHouse(ctx, buildings, h) {
  const built = makeHouse(h);
  ctx.add(built.group);
  const fp = built.footprint;
  ctx.collide(fp.x0, fp.z0, fp.x1, fp.z1, fp.top, undefined, built);
  buildings.push(built);
}

function fillPartyWalls(ctx, buildings) {
  const mat = cel({ color: PAL.concreteMid, bands: 3, tint: 0x6a6288 });
  // Sort north-row buildings and plug micro-gaps with low walls
  const north = buildings.filter((b) => {
    const cz = (b.footprint.z0 + b.footprint.z1) / 2;
    return cz > 5 && cz < 12;
  }).sort((a, b) => a.footprint.x0 - b.footprint.x0);

  for (let i = 0; i < north.length - 1; i++) {
    const a = north[i].footprint;
    const b = north[i + 1].footprint;
    const gap = b.x0 - a.x1;
    if (gap > 0.15 && gap < 2.6) {
      const cx = (a.x1 + b.x0) / 2;
      const cz = (Math.min(a.z1, b.z1) + Math.max(a.z0, b.z0)) / 2;
      const wall = box(Math.max(0.2, gap - 0.1), 1.35, 0.18, mat, cx, 0.67, a.z0 + 0.4);
      wall.castShadow = true;
      ctx.add(wall);
      ctx.collide(cx - gap / 2, a.z0, cx + gap / 2, a.z0 + 0.5, 1.35);
      void cz;
    }
  }
}
