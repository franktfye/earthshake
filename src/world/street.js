import { PAL } from '../core/palette.js';
import { cel } from '../core/toon.js';
import { box } from '../core/util.js';
import { patchGroundMaterial } from './holePunch.js';

/** Side-street carriageway half width — narrow Japanese back street. */
export const ROAD_HALF = 1.9;
/** Central boulevards a little wider than side streets. */
export const MAIN_HALF = 2.6;
export const WALK_W = 1.0;
export const WALK_H = 0.14;
export const FRONT_APRON = 0.25;
/** Map half-extent — 120 m square, sized for a 30-player room. */
export const MAP = { half: 60 };
/** Open civic plaza over the central crossing. */
export const PLAZA = { half: 8.5, top: 0.12 };

export const LOT_TOP = 0.06;
export const ROAD_TOP = 0.1;

/**
 * 3×3 street grid. axis 'x' runs east–west at z = c; axis 'z' runs
 * north–south at x = c.
 */
export const ROADS = [
  { axis: 'x', c: -34, half: ROAD_HALF },
  { axis: 'x', c: 0, half: MAIN_HALF },
  { axis: 'x', c: 34, half: ROAD_HALF },
  { axis: 'z', c: -34, half: ROAD_HALF },
  { axis: 'z', c: 0, half: MAIN_HALF },
  { axis: 'z', c: 34, half: ROAD_HALF },
];

/** Half width of a road corridor including both sidewalks. */
export function corridorHalf(road) {
  return road.half + WALK_W;
}

const M = {};
function mats() {
  if (M.road) return M;
  // Uncached so the hole-punch patch never leaks onto props sharing a colour.
  const g = (o) => patchGroundMaterial(cel({ ...o, cache: false }));
  M.lot = g({ color: PAL.gravel, bands: 3, tint: 0x6a6288 });
  M.road = g({ color: PAL.road, bands: 3, tint: 0x6a608f });
  M.sidewalk = g({ color: PAL.sidewalk, bands: 3, tint: 0x7d74a0 });
  M.sidewalkAlt = g({ color: PAL.sidewalkAlt, bands: 3, tint: 0x7d74a0 });
  M.curb = g({ color: PAL.curb, bands: 3, tint: 0x6f6790 });
  M.line = g({ color: PAL.lineWhite, bands: 2, tint: 0x8e86ad });
  M.tactile = g({ color: PAL.lineYellow, bands: 2, tint: 0x8f7050 });
  M.plaza = g({ color: PAL.concrete, bands: 3, tint: 0x7d74a0 });
  M.plazaInlay = g({ color: PAL.clay, bands: 3, tint: 0x7d6a80 });
  M.lane = g({ color: PAL.sidewalkAlt, bands: 3, tint: 0x7d74a0 });
  M.laneEdge = g({ color: PAL.concreteMid, bands: 3, tint: 0x6a6288 });
  M.monument = cel({ color: PAL.concreteMid, bands: 3, tint: 0x6a6288 });
  M.clock = cel({ color: PAL.wallWhite, bands: 3, tint: 0x6f6790 });
  return M;
}

export function groundY(_z) {
  return 0;
}

/** Intervals along `road` (in its running axis) interrupted by crossing carriageways. */
function crossings(road) {
  return ROADS.filter((r) => r.axis !== road.axis).map((r) => [r.c - r.half, r.c + r.half]);
}

/** Subtract sorted [a,b] gaps from [from,to]. */
export function subtractIntervals(from, to, gaps) {
  const out = [];
  let cur = from;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0])) {
    if (b <= cur) continue;
    if (a >= to) break;
    if (a > cur) out.push([cur, Math.min(a, to)]);
    cur = Math.max(cur, b);
  }
  if (cur < to) out.push([cur, to]);
  return out.filter(([a, b]) => b - a > 0.05);
}

/** Axis-aligned rect helper in world xz from (along, across) ranges of a road. */
function roadRect(road, a0, a1, c0, c1) {
  return road.axis === 'x'
    ? { x0: a0, x1: a1, z0: c0, z1: c1 }
    : { x0: c0, x1: c1, z0: a0, z1: a1 };
}

function addSlab(ctx, rect, y0, y1, mat) {
  const w = rect.x1 - rect.x0;
  const d = rect.z1 - rect.z0;
  const m = box(w, y1 - y0, d, mat, (rect.x0 + rect.x1) / 2, (y0 + y1) / 2, (rect.z0 + rect.z1) / 2);
  m.receiveShadow = true;
  m.castShadow = false;
  ctx.add(m);
  return m;
}

export function buildStreet(ctx) {
  const m = mats();
  const H = MAP.half;
  const P = PLAZA.half;
  const openRects = [];
  const sidewalks = [];
  const carriages = [];
  ctx.carriages = carriages;
  ctx.openRects = openRects;
  ctx.sidewalks = sidewalks;

  // One lot slab under the whole map (punchable). Roads/sidewalks sit on it.
  addSlab(ctx, { x0: -H, x1: H, z0: -H, z1: H }, -0.04, LOT_TOP, m.lot);
  ctx.platform({ x0: -H, x1: H, z0: -H, z1: H, top: LOT_TOP });

  for (const road of ROADS) {
    // Carriageway — full length, crossings overlap coplanar with the same material
    const carriage = roadRect(road, -H, H, road.c - road.half, road.c + road.half);
    addSlab(ctx, carriage, 0.02, ROAD_TOP, m.road);
    ctx.platform({ ...carriage, top: ROAD_TOP });
    openRects.push(carriage);
    carriages.push({ road, rect: carriage });

    // Sidewalks + curbs per side, broken at crossings (corner squares belong
    // to the crossing road's sidewalk) and at the plaza.
    const gaps = ROADS
      .filter((r) => r.axis !== road.axis)
      .map((r) => [r.c - r.half - WALK_W, r.c + r.half + WALK_W]);
    for (const side of [-1, 1]) {
      const inner = road.c + side * road.half;
      const outer = road.c + side * (road.half + WALK_W);
      const c0 = Math.min(inner, outer);
      const c1 = Math.max(inner, outer);
      const inPlazaBand = Math.max(Math.abs(c0), Math.abs(c1)) < P;
      const walkGaps = inPlazaBand ? [...gaps, [-P, P]] : gaps;
      // Own corner squares: extend this sidewalk across crossing sidewalks
      // only for 'z' roads; 'x' roads stop short of them.
      const ownGaps = road.axis === 'z'
        ? crossings(road).concat(inPlazaBand ? [[-P, P]] : [])
        : walkGaps;
      for (const [a, b] of subtractIntervals(-H, H, ownGaps)) {
        const rect = roadRect(road, a, b, c0, c1);
        addSlab(ctx, rect, 0.0, WALK_H, (side > 0) ? m.sidewalk : m.sidewalkAlt);
        ctx.platform({ ...rect, top: WALK_H });
        openRects.push(rect);
        sidewalks.push({ road, side, a, b, inner, outer });
      }
      // Curb strip on the road edge, interrupted wherever traffic crosses
      const curbGaps = crossings(road).concat(inPlazaBand ? [[-P, P]] : []);
      for (const [a, b] of subtractIntervals(-H, H, curbGaps)) {
        const cc = inner - side * 0.06;
        const rect = roadRect(road, a, b, cc - 0.06, cc + 0.06);
        addSlab(ctx, rect, 0.0, 0.18, m.curb);
      }
      // Tactile paving strips near each crossing
      for (const r of ROADS) {
        if (r.axis === road.axis) continue;
        if (inPlazaBand && Math.abs(r.c) < P) continue;
        for (const s of [-1, 1]) {
          const at = r.c + s * (r.half + WALK_W + 0.7);
          if (Math.abs(at) > H - 1) continue;
          const mid = (c0 + c1) / 2;
          addSlab(ctx, roadRect(road, at - 0.3, at + 0.3, mid - 0.45, mid + 0.45), WALK_H, WALK_H + 0.012, m.tactile);
        }
      }
    }

    // Centre dashes + zebra crossings
    const dashGaps = crossings(road).map(([a, b]) => [a - 2.6, b + 2.6]);
    if (Math.abs(road.c) < P) dashGaps.push([-P - 1, P + 1]);
    for (const [a, b] of subtractIntervals(-H + 1, H - 1, dashGaps)) {
      for (let s = a + 0.6; s + 1.4 <= b; s += 3.5) {
        addSlab(ctx, roadRect(road, s, s + 1.4, road.c - 0.06, road.c + 0.06), ROAD_TOP, ROAD_TOP + 0.01, m.line);
      }
    }
    for (const r of ROADS) {
      if (r.axis === road.axis) continue;
      if (Math.abs(r.c) < P && Math.abs(road.c) < P) continue; // plaza crossing
      for (const s of [-1, 1]) {
        const a = r.c + s * (r.half + 0.5);
        const a0 = Math.min(a, a + s * 2.0);
        const a1 = Math.max(a, a + s * 2.0);
        for (let k = road.c - road.half + 0.5; k + 0.45 <= road.c + road.half - 0.3; k += 0.9) {
          addSlab(ctx, roadRect(road, a0, a1, k, k + 0.45), ROAD_TOP, ROAD_TOP + 0.01, m.line);
        }
      }
    }
  }

  // Central plaza — open paving over the boulevard crossing
  const plaza = { x0: -P, x1: P, z0: -P, z1: P };
  addSlab(ctx, plaza, 0.02, PLAZA.top, m.plaza);
  ctx.platform({ ...plaza, top: PLAZA.top });
  openRects.push(plaza);
  // Inlaid ring + cross pattern (flush, 5 mm proud)
  for (const [x0, x1, z0, z1] of [
    [-P + 0.6, P - 0.6, -P + 0.6, -P + 1.0],
    [-P + 0.6, P - 0.6, P - 1.0, P - 0.6],
    [-P + 0.6, -P + 1.0, -P + 0.6, P - 0.6],
    [P - 1.0, P - 0.6, -P + 0.6, P - 0.6],
    [-0.25, 0.25, -P + 1.0, -2.2],
    [-0.25, 0.25, 2.2, P - 1.0],
    [-P + 1.0, -2.2, -0.25, 0.25],
    [2.2, P - 1.0, -0.25, 0.25],
  ]) {
    addSlab(ctx, { x0, x1, z0, z1 }, PLAZA.top, PLAZA.top + 0.005, m.plazaInlay);
  }
  // Clock monument — a landmark to navigate by (blocks hazards at the centre)
  const base = box(2.6, 0.5, 2.6, m.monument, 0, 0.25, 0);
  const shaft = box(0.9, 4.6, 0.9, m.monument, 0, 2.8, 0);
  const head = box(1.5, 1.5, 1.5, m.clock, 0, 5.6, 0);
  for (const o of [base, shaft, head]) {
    o.castShadow = true;
    o.receiveShadow = true;
    ctx.add(o);
  }
  ctx.collide(-1.3, -1.3, 1.3, 1.3, 6.5);

  // Perimeter wall
  const wallH = 2.8;
  for (const e of [
    { x: 0, z: -H - 0.3, w: H * 2.15, d: 0.5 },
    { x: 0, z: H + 0.3, w: H * 2.15, d: 0.5 },
    { x: -H - 0.3, z: 0, w: 0.5, d: H * 2.15 },
    { x: H + 0.3, z: 0, w: 0.5, d: H * 2.15 },
  ]) {
    const wall = box(e.w, wallH, e.d, m.monument, e.x, wallH / 2, e.z);
    wall.castShadow = true;
    ctx.add(wall);
    ctx.collide(e.x - e.w / 2, e.z - e.d / 2, e.x + e.w / 2, e.z + e.d / 2, wallH);
  }
}

export const LANE_TOP = 0.09;

/** Paved back lane through a block (walkable, hazards can land in it). */
export function addLane(ctx, rect, alongX) {
  const m = mats();
  addSlab(ctx, rect, 0.0, LANE_TOP, m.lane);
  // gutter strips along both edges
  const g = 0.22;
  if (alongX) {
    addSlab(ctx, { ...rect, z1: rect.z0 + g }, LANE_TOP, LANE_TOP + 0.006, m.laneEdge);
    addSlab(ctx, { ...rect, z0: rect.z1 - g }, LANE_TOP, LANE_TOP + 0.006, m.laneEdge);
  } else {
    addSlab(ctx, { ...rect, x1: rect.x0 + g }, LANE_TOP, LANE_TOP + 0.006, m.laneEdge);
    addSlab(ctx, { ...rect, x0: rect.x1 - g }, LANE_TOP, LANE_TOP + 0.006, m.laneEdge);
  }
  ctx.platform({ ...rect, top: LANE_TOP });
  ctx.openRects.push(rect);
}

/**
 * 30 spawn slots spread over the grid (mid-block road segments + plaza ring),
 * interleaved so the first N players are already far apart.
 */
export function spawnPoints() {
  const pts = [];
  const along = [-47, -17, 17, 47];
  for (const t of along) {
    for (const road of ROADS) {
      const lateral = (pts.length % 2 ? 1 : -1) * Math.min(1.4, road.half * 0.4);
      const yaw = road.axis === 'x' ? (t < 0 ? -Math.PI / 2 : Math.PI / 2) : (t < 0 ? Math.PI : 0);
      pts.push(road.axis === 'x'
        ? { x: t, z: road.c + lateral, yaw }
        : { x: road.c + lateral, z: t, yaw });
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    pts.push({ x: Math.cos(a) * 5.4, z: Math.sin(a) * 5.4, yaw: Math.atan2(Math.cos(a), Math.sin(a)) });
  }
  // interleave: plaza first, then one per road quadrant round-robin
  const order = [24, 0, 10, 20, 7, 25, 3, 13, 17, 26, 5, 15, 22, 1, 27, 11, 18, 8, 28, 2, 14, 21, 6, 29, 4, 12, 19, 9, 16, 23];
  return order.map((i) => pts[i]);
}
