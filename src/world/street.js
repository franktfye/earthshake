import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel } from '../core/toon.js';
import { box } from '../core/util.js';

/** Match sakura-crossing street.js */
export const ROAD_HALF = 3.15;
export const WALK_W = 1.55;
export const WALK_H = 0.14;
/** Map half-extent — compact playable footprint */
export const MAP = { half: 34 };

/**
 * House frontage depth centerline:
 * sidewalk outer = ROAD_HALF + WALK_W = 4.70
 * house depth ~6.0 → center = outer + depth/2 + apron
 * apron 0.25 m (sakura-like tiny forecourt, not a vacant pad)
 */
export const FRONT_APRON = 0.25;
export function frontCenter(depth = 6.0) {
  return ROAD_HALF + WALK_W + FRONT_APRON + depth / 2;
}

const M = {};
function mats() {
  if (M.road) return M;
  M.road = cel({ color: PAL.road, bands: 3, tint: 0x6a608f });
  M.sidewalk = cel({ color: PAL.sidewalk, bands: 3, tint: 0x7d74a0 });
  M.sidewalkAlt = cel({ color: PAL.sidewalkAlt, bands: 3, tint: 0x7d74a0 });
  M.curb = cel({ color: PAL.curb, bands: 3, tint: 0x6f6790 });
  M.dirt = cel({ color: PAL.dirt, bands: 3, tint: 0x7a7396 });
  M.line = cel({ color: PAL.lineWhite, bands: 2, tint: 0x8e86ad });
  M.concrete = cel({ color: PAL.concrete, bands: 3, tint: 0x6f6790 });
  M.concreteMid = cel({ color: PAL.concreteMid, bands: 3, tint: 0x6a6288 });
  M.tactile = cel({ color: PAL.lineYellow, bands: 2, tint: 0x8f7050 });
  M.gravel = cel({ color: PAL.gravel, bands: 3, tint: 0x6a6288 });
  return M;
}

export function groundY(_z) {
  return 0;
}

/** Lot paving so dirt never reads as empty pad behind the curb. */
export function paveLot(ctx, { x0, x1, z0, z1, y = 0.04 }) {
  const m = mats();
  const w = x1 - x0;
  const d = z1 - z0;
  const slab = box(w, 0.08, d, m.gravel, (x0 + x1) / 2, y, (z0 + z1) / 2);
  slab.receiveShadow = true;
  ctx.add(slab);
}

export function buildStreet(ctx) {
  const m = mats();
  const H = MAP.half;

  // base under everything
  const ground = box(H * 2.2, 0.06, H * 2.2, m.dirt, 0, -0.05, 0);
  ground.receiveShadow = true;
  ctx.add(ground);

  // continuous lot paving N/S/E/W of the cross (kills empty dirt silhouette)
  paveLot(ctx, { x0: -H, x1: H, z0: ROAD_HALF + WALK_W, z1: H });
  paveLot(ctx, { x0: -H, x1: H, z0: -H, z1: -(ROAD_HALF + WALK_W) });
  paveLot(ctx, { x0: -H, x1: -(ROAD_HALF + WALK_W), z0: -(ROAD_HALF + WALK_W), z1: ROAD_HALF + WALK_W });
  paveLot(ctx, { x0: ROAD_HALF + WALK_W, x1: H, z0: -(ROAD_HALF + WALK_W), z1: ROAD_HALF + WALK_W });

  const main = box(H * 2, 0.1, ROAD_HALF * 2, m.road, 0, 0.05, 0);
  main.receiveShadow = true;
  ctx.add(main);
  ctx.platform({ x0: -H, x1: H, z0: -ROAD_HALF, z1: ROAD_HALF, top: 0.1 });

  const cross = box(ROAD_HALF * 2, 0.1, H * 2, m.road, 0, 0.05, 0);
  cross.receiveShadow = true;
  ctx.add(cross);
  ctx.platform({ x0: -ROAD_HALF, x1: ROAD_HALF, z0: -H, z1: H, top: 0.1 });

  for (const side of [-1, 1]) {
    const z = side * (ROAD_HALF + WALK_W / 2);
    const walk = box(H * 2, WALK_H, WALK_W, side > 0 ? m.sidewalk : m.sidewalkAlt, 0, WALK_H / 2, z);
    walk.receiveShadow = true;
    ctx.add(walk);
    ctx.platform({ x0: -H, x1: H, z0: z - WALK_W / 2, z1: z + WALK_W / 2, top: WALK_H });
    ctx.add(box(H * 2, 0.18, 0.12, m.curb, 0, 0.09, side * ROAD_HALF));
    for (const x of [-8, -5, -2, 2, 5, 8]) {
      ctx.add(box(0.85, 0.02, 0.32, m.tactile, x, WALK_H + 0.01, z));
    }
  }

  for (const side of [-1, 1]) {
    const x = side * (ROAD_HALF + WALK_W / 2);
    const walk = box(WALK_W, WALK_H, H * 2, m.sidewalk, x, WALK_H / 2, 0);
    walk.receiveShadow = true;
    ctx.add(walk);
    ctx.platform({ x0: x - WALK_W / 2, x1: x + WALK_W / 2, z0: -H, z1: H, top: WALK_H });
    ctx.add(box(0.12, 0.18, H * 2, m.curb, side * ROAD_HALF, 0.09, 0));
  }

  for (let x = -H + 2; x < H; x += 3.5) {
    ctx.add(box(1.4, 0.02, 0.1, m.line, x, 0.11, 0));
  }

  // perimeter
  const wallH = 2.8;
  for (const e of [
    { x: 0, z: -H - 0.3, w: H * 2.15, d: 0.5 },
    { x: 0, z: H + 0.3, w: H * 2.15, d: 0.5 },
    { x: -H - 0.3, z: 0, w: 0.5, d: H * 2.15 },
    { x: H + 0.3, z: 0, w: 0.5, d: H * 2.15 },
  ]) {
    const wall = box(e.w, wallH, e.d, m.concrete, e.x, wallH / 2, e.z);
    wall.castShadow = true;
    ctx.add(wall);
    ctx.collide(e.x - e.w / 2, e.z - e.d / 2, e.x + e.w / 2, e.z + e.d / 2, wallH);
  }
}
