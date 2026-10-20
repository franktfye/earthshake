import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { box, cyl, bake, trs, rngKit, sagCurve, shadowify } from '../core/util.js';
import { hullOutline } from '../core/outline.js';
import { ROAD_HALF, WALK_W, MAP } from './street.js';

const M = {};
function mats() {
  if (M.pole) return M;
  M.pole = cel({ color: 0xd6d2d8, bands: 3, tint: 0x6a6288 });
  M.metal = cel({ color: PAL.metal, bands: 3, tint: 0x666090 });
  M.metalDark = cel({ color: PAL.metalDark, bands: 3, tint: 0x5c5680 });
  M.dark = cel({ color: PAL.black, bands: 2, tint: 0x4b4560 });
  M.wire = cel({ color: 0x4c4658, bands: 2, tint: 0x413c58 });
  M.white = cel({ color: PAL.wallWhite, bands: 3, tint: 0x6f6790 });
  M.concrete = cel({ color: PAL.concrete, bands: 3, tint: 0x6f6790 });
  M.leaf = cel({ color: PAL.leaf, bands: 3, tint: 0x5b6f8c });
  M.bin = cel({ color: PAL.bin, bands: 3, tint: 0x4a6a80 });
  M.wood = cel({ color: PAL.wood, bands: 3, tint: 0x5c5680 });
  M.red = cel({ color: PAL.red, bands: 3, tint: 0x7a4060 });
  M.yellow = cel({ color: PAL.yellow, bands: 3, tint: 0x8f7050 });
  return M;
}

export function makePole(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  const H = o.h ?? 8.4;
  const parts = { pole: [], metal: [], dark: [], white: [] };
  const push = (k, geo, mx) => parts[k].push({ geometry: geo, matrix: mx });
  push('pole', new THREE.CylinderGeometry(0.11, 0.18, H, 8), trs(0, H / 2, 0));
  push('pole', new THREE.CylinderGeometry(0.24, 0.28, 0.2, 8), trs(0, 0.1, 0));
  push('dark', new THREE.BoxGeometry(0.09, 0.1, 1.8), trs(0, H - 0.5, 0));
  push('metal', new THREE.CylinderGeometry(0.22, 0.22, 0.55, 8), trs(0.32, H - 2.4, 0));
  push('white', new THREE.CylinderGeometry(0.05, 0.06, 0.14, 6), trs(0, H - 0.35, 0.7));
  push('white', new THREE.CylinderGeometry(0.05, 0.06, 0.14, 6), trs(0, H - 0.35, -0.7));
  const matFor = { pole: m.pole, metal: m.metal, dark: m.dark, white: m.white };
  for (const key of Object.keys(parts)) {
    if (!parts[key].length) continue;
    const mesh = new THREE.Mesh(bake(parts[key]), matFor[key]);
    mesh.castShadow = true;
    g.add(mesh);
    if (key === 'pole') hullOutline(mesh, { thickness: 0.0032 });
  }
  g.position.set(o.x, o.y ?? 0, o.z);
  g.userData.topY = (o.y ?? 0) + H - 0.5;
  return shadowify(g);
}

export function makeWires(ctx, runs) {
  const m = mats();
  const geos = [];
  for (const run of runs) {
    const { points, sag = 0.45, r = 0.024 } = run;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      const dist = a.distanceTo(b);
      const curve = sagCurve(a, b, sag * Math.min(1.5, dist / 14), 10);
      geos.push(new THREE.TubeGeometry(curve, 12, r, 4, false));
    }
  }
  if (!geos.length) return null;
  const merged = geos.length === 1 ? geos[0] : bake(geos.map((geometry) => ({ geometry })));
  const mesh = new THREE.Mesh(merged, m.wire);
  mesh.name = 'wires';
  ctx.add(mesh);
  return mesh;
}

export function makeKeiTruck(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  const base = o.color ?? PAL.taxiYellow;
  const body = cel({ color: base, bands: 3, tint: 0x8f7050 });
  const bodyDeep = cel({ color: PAL.taxiYellowDeep, bands: 3, tint: 0x8f7050 });
  const glass = flat({ color: PAL.glassDark });
  const L = 3.2, W = 1.42;
  g.add(box(L, 0.32, W, bodyDeep, 0, 0.66, 0));
  g.add(box(1.2, 1.0, W, body, L / 2 - 0.65, 1.32, 0));
  g.add(box(0.06, 0.55, W - 0.16, glass, L / 2 - 0.08, 1.55, 0));
  g.add(box(1.7, 0.06, W, cel({ color: 0xbba98c, bands: 3, tint: 0x6f6790 }), -0.55, 0.86, 0));
  for (const s of [-1, 1]) g.add(box(1.7, 0.38, 0.06, body, -0.55, 1.02, s * (W / 2 - 0.03)));
  if (o.load !== 'empty') {
    g.add(box(0.4, 0.28, 0.34, cel({ color: PAL.crate, bands: 3, tint: 0x4a4a92 }), -0.4, 1.08, 0.1));
    g.add(box(0.4, 0.28, 0.34, cel({ color: PAL.crateAlt, bands: 3, tint: 0x7a4060 }), -0.85, 1.08, -0.1));
  }
  const wheelGeo = new THREE.CylinderGeometry(0.28, 0.28, 0.18, 10);
  wheelGeo.rotateX(Math.PI / 2);
  for (const wx of [L / 2 - 0.7, -L / 2 + 0.55]) {
    for (const s of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, m.dark);
      w.position.set(wx, 0.28, s * (W / 2 - 0.05));
      g.add(w);
    }
  }
  g.position.set(o.x, o.y ?? 0, o.z);
  g.rotation.y = o.ry ?? 0;
  if (o.hero !== false) {
    const boxes = [];
    g.traverse((c) => {
      if (c.isMesh && c.geometry?.type === 'BoxGeometry' && !c.userData.isOutline) boxes.push(c);
    });
    for (const c of boxes) {
      const shell = hullOutline(c, { thickness: 0.003 });
      if (shell) shell.userData.isOutline = true;
    }
  }
  return shadowify(g);
}

export function makeBicycle(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  const w1 = cyl(0.28, 0.28, 0.06, 10, m.dark, 0.55, 0.28, 0);
  const w2 = cyl(0.28, 0.28, 0.06, 10, m.dark, -0.55, 0.28, 0);
  w1.rotation.z = Math.PI / 2;
  w2.rotation.z = Math.PI / 2;
  g.add(w1, w2);
  g.add(box(1.1, 0.05, 0.05, m.metalDark, 0, 0.55, 0));
  g.add(box(0.05, 0.45, 0.05, m.metalDark, 0.35, 0.55, 0));
  g.add(box(0.55, 0.04, 0.04, m.metal, 0.35, 0.85, 0));
  g.add(box(0.28, 0.08, 0.18, m.dark, -0.15, 0.72, 0));
  g.position.set(o.x, o.y ?? 0, o.z);
  g.rotation.y = o.ry ?? 0;
  return shadowify(g);
}

export function makeBins(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  g.add(box(0.42, 0.85, 0.42, m.bin, -0.28, 0.42, 0));
  g.add(box(0.42, 0.85, 0.42, cel({ color: 0x6a9a6a, bands: 3, tint: 0x4a6a80 }), 0.28, 0.42, 0));
  g.add(box(0.44, 0.06, 0.44, m.metal, -0.28, 0.88, 0));
  g.add(box(0.44, 0.06, 0.44, m.metal, 0.28, 0.88, 0));
  g.position.set(o.x, o.y ?? 0, o.z);
  return shadowify(g);
}

export function makeCone(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.55, 8), m.red);
  cone.position.y = 0.35;
  g.add(cone);
  g.add(box(0.32, 0.05, 0.32, m.white, 0, 0.04, 0));
  g.position.set(o.x, o.y ?? 0, o.z);
  return shadowify(g);
}

export function makePlanter(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  g.add(box(0.7, 0.45, 0.7, m.concrete, 0, 0.22, 0));
  g.add(box(0.55, 0.35, 0.55, m.leaf, 0, 0.55, 0));
  g.position.set(o.x, o.y ?? 0, o.z);
  return shadowify(g);
}

export function makePostBox(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  g.add(box(0.55, 1.15, 0.4, m.red, 0, 0.7, 0));
  g.add(box(0.58, 0.08, 0.42, m.red, 0, 1.3, 0));
  g.add(box(0.2, 0.08, 0.06, m.dark, 0, 0.95, 0.21));
  g.position.set(o.x, o.y ?? 0, o.z);
  hullOutline(g.children[0], { thickness: 0.003 });
  return shadowify(g);
}

export function makeSignPost(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  g.add(cyl(0.04, 0.05, 2.6, 6, m.metalDark, 0, 1.3, 0));
  g.add(box(0.9, 0.55, 0.05, m.yellow, 0, 2.35, 0));
  g.add(box(0.7, 0.12, 0.02, m.dark, 0, 2.35, 0.04));
  g.position.set(o.x, o.y ?? 0, o.z);
  g.rotation.y = o.ry ?? 0;
  return shadowify(g);
}

export function makeCrates(o = {}) {
  const g = new THREE.Group();
  const rng = rngKit(o.seed ?? 3);
  for (let i = 0; i < (o.count ?? 3); i++) {
    g.add(box(
      rng.range(0.35, 0.5), rng.range(0.28, 0.4), rng.range(0.3, 0.45),
      cel({ color: i % 2 ? PAL.crate : PAL.crateAlt, bands: 3, tint: 0x4a4a92 }),
      rng.range(-0.35, 0.35), 0.2 + i * 0.12, rng.range(-0.2, 0.2)
    ));
  }
  g.position.set(o.x, o.y ?? 0, o.z);
  return shadowify(g);
}

export function makeBarrier(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  g.add(box(1.6, 0.12, 0.08, m.red, 0, 0.95, 0));
  g.add(box(1.6, 0.12, 0.08, m.white, 0, 0.75, 0));
  g.add(box(0.08, 1.0, 0.08, m.metalDark, -0.7, 0.5, 0));
  g.add(box(0.08, 1.0, 0.08, m.metalDark, 0.7, 0.5, 0));
  g.position.set(o.x, o.y ?? 0, o.z);
  g.rotation.y = o.ry ?? 0;
  return shadowify(g);
}

export function makeVending(o = {}) {
  const g = new THREE.Group();
  const body = box(0.95, 1.85, 0.7, cel({ color: PAL.wallWhite, bands: 3, tint: 0x6f6790 }), 0, 0.92, 0);
  g.add(body);
  g.add(box(0.75, 1.1, 0.05, flat({ color: 0x3a4558 }), 0, 1.1, 0.36));
  g.add(box(0.95, 0.35, 0.72, cel({ color: PAL.red, bands: 3, tint: 0x7a4060 }), 0, 1.75, 0));
  const shell = hullOutline(body, { thickness: 0.0034 });
  if (shell) shell.userData.isOutline = true;
  g.position.set(o.x, o.y ?? 0, o.z);
  g.rotation.y = o.ry ?? 0;
  return shadowify(g);
}

export function makeAircon(o = {}) {
  const m = mats();
  const g = box(0.85, 0.55, 0.35, m.white, o.x, o.y ?? 2.4, o.z);
  g.castShadow = true;
  return g;
}

/** Dense street furniture — sakura-like clutter every few metres. */
export function buildStreetProps(ctx) {
  const kerbN = ROAD_HALF + WALK_W * 0.35; // ~3.7 — on sidewalk inner edge
  const kerbS = -kerbN;
  const H = MAP.half;

  // Poles every ~6 m along both main-street kerbs (sakura pole run density)
  const poles = [];
  for (let x = -H + 3; x <= H - 3; x += 6) {
    if (Math.abs(x) < 4.5) continue; // clear crossing sightlines a bit
    poles.push({ x, z: kerbN + 0.55 });
    poles.push({ x: x + 3, z: kerbS - 0.55 });
  }
  for (let z = -H + 4; z <= H - 4; z += 7) {
    if (Math.abs(z) < 5) continue;
    poles.push({ x: kerbN + 0.55, z });
    poles.push({ x: kerbS - 0.55, z: z + 2 });
  }

  const poleTops = [];
  for (const p of poles) {
    const pole = makePole(p);
    ctx.add(pole);
    poleTops.push(new THREE.Vector3(p.x, pole.userData.topY, p.z));
  }

  const north = poleTops.filter((p) => p.z > 3).sort((a, b) => a.x - b.x);
  const south = poleTops.filter((p) => p.z < -3).sort((a, b) => a.x - b.x);
  makeWires(ctx, [
    { points: north, sag: 0.5 },
    { points: south, sag: 0.48 },
  ]);

  // Parked vehicles every block on both sides
  const trucks = [
    { x: -26, z: kerbN + 0.9, ry: 0.04, hero: true },
    { x: -14, z: kerbS - 0.9, ry: Math.PI - 0.03, color: PAL.teal, hero: false },
    { x: -7.5, z: kerbN + 0.9, ry: 0.06, hero: false, load: 'empty' },
    { x: 12, z: kerbS - 0.9, ry: Math.PI, hero: false },
    { x: 19, z: kerbN + 0.9, ry: 0.02, color: PAL.orange, hero: false },
    { x: 27, z: kerbS - 0.9, ry: Math.PI + 0.05, hero: false, load: 'empty' },
    { x: kerbN + 0.9, z: -18, ry: Math.PI / 2, hero: false },
    { x: kerbS - 0.9, z: 16, ry: -Math.PI / 2, color: PAL.blue, hero: false },
  ];
  for (const t of trucks) {
    ctx.add(makeKeiTruck(t));
    ctx.collide(t.x - 1.7, t.z - 0.85, t.x + 1.7, t.z + 0.85, 1.9);
  }

  // Bike clusters every ~8 m
  for (let x = -28; x <= 28; x += 8) {
    if (Math.abs(x) < 5) continue;
    ctx.add(makeBicycle({ x: x - 0.35, z: kerbN + 0.35, ry: 0.35 }));
    ctx.add(makeBicycle({ x: x + 0.35, z: kerbN + 0.45, ry: 0.55 }));
    ctx.add(makeBicycle({ x: x, z: kerbS - 0.4, ry: -0.4 }));
  }

  // Bins / planters / cones / crates along frontages
  for (let x = -30; x <= 30; x += 5) {
    if (Math.abs(x) < 4) continue;
    ctx.add(makeBins({ x, z: kerbN + 0.25 }));
    ctx.add(makePlanter({ x: x + 2.2, z: kerbS - 0.25 }));
    if (x % 10 === 0) ctx.add(makeCone({ x: x + 1, z: ROAD_HALF - 0.35 }));
    if (x % 15 === 0) ctx.add(makeCrates({ x: x - 1.5, z: kerbN + 1.8, seed: 40 + x }));
  }

  for (let z = -28; z <= 28; z += 6) {
    if (Math.abs(z) < 5) continue;
    ctx.add(makeBins({ x: kerbN + 0.25, z }));
    ctx.add(makePlanter({ x: kerbS - 0.25, z: z + 2 }));
    ctx.add(makeCone({ x: ROAD_HALF - 0.3, z: z + 1 }));
  }

  // Post boxes, signs, barriers, vending against walls
  for (const x of [-24, -10, 10, 22]) {
    ctx.add(makePostBox({ x, z: kerbN + 0.4 }));
    ctx.add(makeSignPost({ x: x + 3, z: kerbN + 0.15, ry: 0.05 }));
  }
  for (const x of [-20, 6, 18]) {
    ctx.add(makeBarrier({ x, z: ROAD_HALF - 0.5, ry: 0.08 }));
  }

  const vendZ = ROAD_HALF + WALK_W + FRONT_FACE();
  for (const v of [
    { x: -21, z: vendZ, ry: Math.PI },
    { x: -9, z: vendZ, ry: Math.PI },
    { x: 15, z: vendZ, ry: Math.PI },
    { x: 25, z: -vendZ, ry: 0 },
    { x: -16, z: -vendZ, ry: 0 },
  ]) {
    ctx.add(makeVending(v));
    ctx.collide(v.x - 0.5, v.z - 0.4, v.x + 0.5, v.z + 0.4, 1.9);
  }

  // Aircons pepper building faces
  for (let x = -28; x <= 28; x += 4.5) {
    if (Math.abs(x) < 5) continue;
    ctx.add(makeAircon({ x, y: 2.9, z: vendZ - 0.2 }));
    ctx.add(makeAircon({ x: x + 1.5, y: 3.2, z: -vendZ + 0.2 }));
  }
}

function FRONT_FACE() {
  // approximate building front z for north row
  return ROAD_HALF + WALK_W + 0.25;
}
