import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { shopSign, litWindowTex } from '../core/textures.js';
import { bake, trs, rngKit, shadowify } from '../core/util.js';

const WALLS = [
  PAL.wallWhite, PAL.wallCream, PAL.wallBlue, PAL.wallBeige,
  PAL.wallGray, PAL.wallPink, PAL.wallTea, PAL.wallSage,
];
const ROOFS = [PAL.roofSlate, PAL.roofBlue, PAL.roofBrown, PAL.roofTeal];

const M = {};
function mats() {
  if (M.roofs) return M;
  M.walls = WALLS.map((c) => cel({ color: c, bands: 3, tint: 0x6f6790 }));
  M.roofs = ROOFS.map((c) => cel({ color: c, bands: 3, tint: 0x514b70 }));
  M.trim = cel({ color: PAL.trim, bands: 3, tint: 0x5c5680 });
  M.metal = cel({ color: PAL.metal, bands: 3, tint: 0x666090 });
  M.glass = flat({ color: PAL.glassDark });
  M.concrete = cel({ color: PAL.concrete, bands: 3, tint: 0x6f6790 });
  M.door = cel({ color: PAL.wood, bands: 3, tint: 0x5c5680 });
  M.rubble = cel({ color: PAL.rubble, bands: 3, tint: 0x5c5680 });
  return M;
}

/**
 * Low-rise house generator (sakura-style bake-per-material).
 * Returns { group, footprint, collapseAnchor }.
 */
export function makeHouse(o) {
  const m = mats();
  const rng = rngKit(o.seed ?? 7);
  const g = new THREE.Group();
  g.name = o.name || 'house';
  const w = o.w ?? 6.2;
  const d = o.d ?? 7.0;
  const floors = o.floors ?? 2;
  const fh = 2.72;
  const H = fh * floors;
  const wallMat = m.walls[o.wall ?? rng.int(0, WALLS.length - 1)];
  const roofMat = m.roofs[o.roof ?? rng.int(0, ROOFS.length - 1)];

  const parts = { wall: [], roof: [], trim: [], metal: [], glass: [], concrete: [], door: [] };
  const push = (k, geo, mx) => parts[k].push({ geometry: geo, matrix: mx });

  push('wall', new THREE.BoxGeometry(w, H, d), trs(0, H / 2, 0));
  push('concrete', new THREE.BoxGeometry(w + 0.14, 0.42, d + 0.14), trs(0, 0.21, 0));
  if (floors === 2) {
    push('trim', new THREE.BoxGeometry(w + 0.08, 0.12, d + 0.08), trs(0, fh, 0));
  }

  // simple gable / flat roof
  const roofKind = o.roofKind ?? rng.pick(['gable', 'flat', 'hip']);
  const eave = 0.42;
  if (roofKind === 'flat') {
    push('roof', new THREE.BoxGeometry(w + eave, 0.22, d + eave), trs(0, H + 0.11, 0));
    push('metal', new THREE.BoxGeometry(w * 0.3, 0.5, 0.5), trs(w * 0.2, H + 0.45, -d * 0.2));
  } else {
    const rh = 1.1 + rng.range(0, 0.4);
    const alongZ = d >= w;
    const span = alongZ ? w + eave * 2 : d + eave * 2;
    const len = alongZ ? d + eave * 2 : w + eave * 2;
    const slope = Math.atan2(rh, span / 2);
    const slabLen = Math.hypot(span / 2, rh) + 0.08;
    for (const s of [-1, 1]) {
      const geo = new THREE.BoxGeometry(alongZ ? slabLen : len, 0.14, alongZ ? len : slabLen);
      const mx = alongZ
        ? trs(s * (span / 4), H + rh / 2, 0, 0, 0, -s * slope)
        : trs(0, H + rh / 2, s * (span / 4), s * slope, 0, 0);
      push('roof', geo, mx);
    }
  }

  // windows on front (+Z local, then rotated by face)
  const winTex = litWindowTex();
  const winMat = flat({ color: 0xffffff, map: winTex });
  for (let f = 0; f < floors; f++) {
    const wy = fh * f + 1.35;
    for (const sx of [-w * 0.28, w * 0.28]) {
      push('glass', new THREE.PlaneGeometry(1.1, 1.2), trs(sx, wy, d / 2 + 0.02));
    }
  }
  push('door', new THREE.BoxGeometry(1.0, 2.1, 0.08), trs(0, 1.05, d / 2 + 0.04));

  const matMap = {
    wall: wallMat, roof: roofMat, trim: m.trim, metal: m.metal,
    glass: winMat, concrete: m.concrete, door: m.door,
  };
  for (const [k, list] of Object.entries(parts)) {
    if (!list.length) continue;
    const mesh = new THREE.Mesh(bake(list), matMap[k]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    g.add(mesh);
  }

  const faceRy = { 'z+': 0, 'z-': Math.PI, 'x+': Math.PI / 2, 'x-': -Math.PI / 2 };
  g.rotation.y = faceRy[o.face ?? 'z+'] ?? 0;
  g.position.set(o.x, o.y ?? 0, o.z);

  const hw = w / 2 + 0.05;
  const hd = d / 2 + 0.05;
  // world-axis AABB (approximate; fine for axis-aligned faces)
  const footprint = {
    x0: o.x - (o.face === 'x+' || o.face === 'x-' ? hd : hw),
    x1: o.x + (o.face === 'x+' || o.face === 'x-' ? hd : hw),
    z0: o.z - (o.face === 'x+' || o.face === 'x-' ? hw : hd),
    z1: o.z + (o.face === 'x+' || o.face === 'x-' ? hw : hd),
    top: H + 1.5,
  };

  return {
    group: shadowify(g),
    footprint,
    height: H,
    collapseType: o.collapseType || rng.pick(['lean', 'pancake', 'facade']),
  };
}

/** Small shop with Canvas2D fascia. */
export function makeShop(o) {
  const m = mats();
  const g = new THREE.Group();
  g.name = o.name || 'shop';
  const w = o.w ?? 7.5;
  const d = o.d ?? 8.0;
  const H = 3.6;

  const parts = { wall: [], roof: [], trim: [], concrete: [], glass: [] };
  const push = (k, geo, mx) => parts[k].push({ geometry: geo, matrix: mx });
  const wallMat = m.walls[o.wall ?? 0];

  push('wall', new THREE.BoxGeometry(w, H, d), trs(0, H / 2, 0));
  push('concrete', new THREE.BoxGeometry(w + 0.1, 0.35, d + 0.1), trs(0, 0.18, 0));
  push('roof', new THREE.BoxGeometry(w + 0.5, 0.2, d + 0.5), trs(0, H + 0.1, 0));
  push('glass', new THREE.BoxGeometry(w * 0.7, 2.0, 0.08), trs(0, 1.4, d / 2 + 0.04));

  const matMap = {
    wall: wallMat, roof: m.roofs[0], trim: m.trim,
    concrete: m.concrete, glass: m.glass,
  };
  for (const [k, list] of Object.entries(parts)) {
    if (!list.length) continue;
    g.add(new THREE.Mesh(bake(list), matMap[k]));
  }

  // fascia sign
  const sign = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 0.85, 0.7),
    flat({ color: 0xffffff, map: shopSign(o.label || '角の店') })
  );
  sign.position.set(0, H - 0.2, d / 2 + 0.06);
  g.add(sign);

  const faceRy = { 'z+': 0, 'z-': Math.PI, 'x+': Math.PI / 2, 'x-': -Math.PI / 2 };
  g.rotation.y = faceRy[o.face ?? 'z+'] ?? 0;
  g.position.set(o.x, o.y ?? 0, o.z);

  const hw = w / 2, hd = d / 2;
  const footprint = {
    x0: o.x - (o.face === 'x+' || o.face === 'x-' ? hd : hw),
    x1: o.x + (o.face === 'x+' || o.face === 'x-' ? hd : hw),
    z0: o.z - (o.face === 'x+' || o.face === 'x-' ? hw : hd),
    z1: o.z + (o.face === 'x+' || o.face === 'x-' ? hw : hd),
    top: H + 1.2,
  };

  return {
    group: shadowify(g),
    footprint,
    height: H,
    collapseType: o.collapseType || 'facade',
  };
}

/** Rubble pile replacing a collapsed building. */
export function makeRubble(footprint, height, seed = 1) {
  const m = mats();
  const rng = rngKit(seed);
  const g = new THREE.Group();
  g.name = 'rubble';
  const cx = (footprint.x0 + footprint.x1) / 2;
  const cz = (footprint.z0 + footprint.z1) / 2;
  const ww = footprint.x1 - footprint.x0;
  const dd = footprint.z1 - footprint.z0;
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const bw = rng.range(0.6, ww * 0.45);
    const bh = rng.range(0.3, Math.min(1.8, height * 0.35));
    const bd = rng.range(0.5, dd * 0.4);
    parts.push({
      geometry: new THREE.BoxGeometry(bw, bh, bd),
      matrix: trs(
        rng.range(-ww * 0.3, ww * 0.3),
        bh / 2,
        rng.range(-dd * 0.3, dd * 0.3),
        rng.range(-0.4, 0.4),
        rng.range(0, Math.PI),
        rng.range(-0.3, 0.3)
      ),
    });
  }
  const mesh = new THREE.Mesh(bake(parts), m.rubble);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  g.add(mesh);
  g.position.set(cx, 0, cz);
  return shadowify(g);
}
