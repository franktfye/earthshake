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

/** Road / dirt / lane lines — punched when fissures open so pits are visible. */
export function getPunchableGroundMats() {
  const m = mats();
  return [m.road, m.dirt, m.line];
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

/**
 * Tile road + dirt under the cross so fissures can hide tiles and reveal
 * the open black shaft (whole-slab asphalt cannot be punched reliably).
 */
function addPunchTile(ctx, list, mesh, x, z, hw, hd) {
  mesh.receiveShadow = true;
  ctx.add(mesh);
  list.push({ mesh, x, z, hw, hd });
}

export function buildStreet(ctx) {
  const m = mats();
  const H = MAP.half;
  const TILE = 1.25; // finer grid → cleaner circular cut around fissures
  const punchTiles = [];
  ctx.punchTiles = punchTiles;

  // No single dirt slab under the road — that would fill fissures.
  // Lots use paveLot; road corridor uses hideable dirt tiles below.

  // continuous lot paving N/S/E/W of the cross (kills empty dirt silhouette)
  paveLot(ctx, { x0: -H, x1: H, z0: ROAD_HALF + WALK_W, z1: H });
  paveLot(ctx, { x0: -H, x1: H, z0: -H, z1: -(ROAD_HALF + WALK_W) });
  paveLot(ctx, { x0: -H, x1: -(ROAD_HALF + WALK_W), z0: -(ROAD_HALF + WALK_W), z1: ROAD_HALF + WALK_W });
  paveLot(ctx, { x0: ROAD_HALF + WALK_W, x1: H, z0: -(ROAD_HALF + WALK_W), z1: ROAD_HALF + WALK_W });

  // Main E–W road as tiles + dirt underlay tiles (hide together with fissures)
  const roadZ = ROAD_HALF * 2;
  for (let x = -H; x < H - 0.01; x += TILE) {
    const cx = x + TILE / 2;
    const w = Math.min(TILE, H - x);
    const dirt = box(w, 0.06, roadZ + 0.4, m.dirt, cx, -0.05, 0);
    addPunchTile(ctx, punchTiles, dirt, cx, 0, w / 2, (roadZ + 0.4) / 2);
    const asphalt = box(w, 0.1, roadZ, m.road, cx, 0.05, 0);
    addPunchTile(ctx, punchTiles, asphalt, cx, 0, w / 2, roadZ / 2);
  }
  ctx.platform({ x0: -H, x1: H, z0: -ROAD_HALF, z1: ROAD_HALF, top: 0.1 });

  // N–S cross road tiles (skip overlap band already covered by main)
  const roadX = ROAD_HALF * 2;
  for (let z = -H; z < H - 0.01; z += TILE) {
    const cz = z + TILE / 2;
    if (Math.abs(cz) < ROAD_HALF + TILE * 0.5) continue; // overlap with main
    const d = Math.min(TILE, H - z);
    const dirt = box(roadX + 0.4, 0.06, d, m.dirt, 0, -0.05, cz);
    addPunchTile(ctx, punchTiles, dirt, 0, cz, (roadX + 0.4) / 2, d / 2);
    const asphalt = box(roadX, 0.1, d, m.road, 0, 0.05, cz);
    addPunchTile(ctx, punchTiles, asphalt, 0, cz, roadX / 2, d / 2);
  }
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
    const line = box(1.4, 0.02, 0.1, m.line, x, 0.11, 0);
    addPunchTile(ctx, punchTiles, line, x, 0, 0.7, 0.05);
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
