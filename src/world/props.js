import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { box, cyl, bake, trs, rngKit, sagCurve, shadowify } from '../core/util.js';
import { hullOutline } from '../core/outline.js';
import { MAP, WALK_H, ROAD_TOP } from './street.js';

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

/** Compact sedan — parked cars and runaway-car hazard body. Front is +X. */
export function makeSedan(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  const body = cel({ color: o.color ?? PAL.blue, bands: 3, tint: 0x5c5680 });
  const glass = flat({ color: PAL.glassDark });
  const L = 3.6, W = 1.6;
  g.add(box(L, 0.55, W, body, 0, 0.6, 0));
  g.add(box(L * 0.55, 0.5, W - 0.12, body, -0.15, 1.12, 0));
  g.add(box(0.06, 0.38, W - 0.3, glass, L * 0.125 + 0.02, 1.12, 0));
  g.add(box(L * 0.5, 0.34, 0.04, glass, -0.15, 1.12, W / 2 - 0.05));
  g.add(box(L * 0.5, 0.34, 0.04, glass, -0.15, 1.12, -W / 2 + 0.05));
  g.add(box(0.05, 0.12, 0.3, flat({ color: 0xfff4d0 }), L / 2 + 0.01, 0.68, 0.5));
  g.add(box(0.05, 0.12, 0.3, flat({ color: 0xfff4d0 }), L / 2 + 0.01, 0.68, -0.5));
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.2, 10);
  wheelGeo.rotateX(Math.PI / 2);
  for (const wx of [L / 2 - 0.7, -L / 2 + 0.7]) {
    for (const s2 of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, m.dark);
      w.position.set(wx, 0.3, s2 * (W / 2 - 0.05));
      g.add(w);
    }
  }
  g.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  g.rotation.y = o.ry ?? 0;
  return shadowify(g);
}

/** Boxy delivery van. Front is +X. */
export function makeVan(o = {}) {
  const m = mats();
  const g = new THREE.Group();
  const body = cel({ color: o.color ?? PAL.wallWhite, bands: 3, tint: 0x6f6790 });
  const stripe = cel({ color: o.stripe ?? PAL.teal, bands: 3, tint: 0x4a6a80 });
  const glass = flat({ color: PAL.glassDark });
  const L = 3.9, W = 1.7;
  g.add(box(L, 1.55, W, body, 0, 1.05, 0));
  g.add(box(L + 0.02, 0.2, W + 0.02, stripe, 0, 0.75, 0));
  g.add(box(0.06, 0.55, W - 0.3, glass, L / 2 + 0.01, 1.45, 0));
  const wheelGeo = new THREE.CylinderGeometry(0.32, 0.32, 0.2, 10);
  wheelGeo.rotateX(Math.PI / 2);
  for (const wx of [L / 2 - 0.7, -L / 2 + 0.7]) {
    for (const s2 of [-1, 1]) {
      const w = new THREE.Mesh(wheelGeo, m.dark);
      w.position.set(wx, 0.32, s2 * (W / 2 - 0.05));
      g.add(w);
    }
  }
  g.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  g.rotation.y = o.ry ?? 0;
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

/**
 * Street furniture along every sidewalk segment of the grid.
 * Small props register as `looseProps` (they tumble into fissures);
 * poles/vending/trucks are solid and fissures avoid them.
 */
export function buildStreetProps(ctx) {
  const looseProps = [];
  const avoid = [];
  ctx.looseProps = looseProps;
  ctx.avoid = avoid;
  /**
   * Keep the sidewalk in front of every back-lane entrance clear, so a lane
   * mouth is never plugged by bikes / bins / a vending machine.
   */
  const MOUTH = 1.6;
  const inLaneMouth = (x, z, hx = 0.3, hz = 0.3) => (ctx.lanes || []).some(({ rect: L, alongX: ax }) => {
    const x0 = L.x0 - (ax ? MOUTH : 0.4);
    const x1 = L.x1 + (ax ? MOUTH : 0.4);
    const z0 = L.z0 - (ax ? 0.4 : MOUTH);
    const z1 = L.z1 + (ax ? 0.4 : MOUTH);
    return x + hx > x0 && x - hx < x1 && z + hz > z0 && z - hz < z1;
  });

  /** Street clutter: solid (bins, planters… block you) but can tumble into fissures. */
  const loose = (obj, x, z, hx = 0.3, hz = 0.3, top = 0.9) => {
    if (inLaneMouth(x, z, hx, hz)) return;
    ctx.add(obj);
    const lp = { obj, x, z, loose: true };
    ctx.collide(x - hx, z - hz, x + hx, z + hz, (obj.position.y || 0) + top, undefined, lp);
    looseProps.push(lp);
  };
  const H = MAP.half;
  const wireRuns = new Map();
  /** Parked cars per road: { t (along), halfL, side } — keeps streets passable. */
  const parked = new Map();
  const CAR_GAP = 1.5;

  ctx.sidewalks.forEach((sw, si) => {
    const { road, side, a, b, inner, outer } = sw;
    const len = b - a;
    if (len < 4) return;
    const alongX = road.axis === 'x';
    // world position from (along, across)
    const at = (t, c, y = WALK_H) => (alongX ? { x: t, y, z: c } : { x: c, y, z: t });
    // yaw that faces the carriageway from this side
    const faceRoad = alongX ? (side > 0 ? Math.PI : 0) : (side > 0 ? -Math.PI / 2 : Math.PI / 2);
    const curbC = inner + side * 0.35;
    const wallC = outer - side * 0.3;

    // Utility poles on one side of each road, wired up per run
    const poleSide = alongX ? 1 : -1;
    if (side === poleSide) {
      const key = `${road.axis}${road.c}`;
      if (!wireRuns.has(key)) wireRuns.set(key, []);
      for (let t = a + 2; t <= b - 2; t += 7) {
        const p = at(t, curbC);
        if (inLaneMouth(p.x, p.z, 0.25, 0.25)) continue;
        const pole = makePole(p);
        ctx.add(pole);
        ctx.collide(p.x - 0.2, p.z - 0.2, p.x + 0.2, p.z + 0.2, 8);
        avoid.push({ x: p.x, z: p.z, r: 0.45 });
        wireRuns.get(key).push(new THREE.Vector3(p.x, pole.userData.topY, p.z));
      }
    }

    // Clutter cycle every ~4.6 m, near building fronts / curb
    let k = si * 3;
    for (let t = a + 2.4; t <= b - 2.2; t += 4.6, k++) {
      const kind = k % 6;
      if (kind === 0) {
        const p = at(t, wallC);
        loose(makeBins(p), p.x, p.z, 0.52, 0.24, 0.95);
      } else if (kind === 1) {
        const p = at(t, wallC);
        loose(makePlanter(p), p.x, p.z, 0.36, 0.36, 0.75);
      } else if (kind === 2) {
        for (const d of [-0.35, 0.35]) {
          const p = at(t + d, wallC - side * 0.1);
          loose(makeBicycle({ ...p, ry: (alongX ? 0 : Math.PI / 2) + 0.45 }), p.x, p.z, 0.4, 0.4, 0.9);
        }
      } else if (kind === 3) {
        const p = at(t, inner - side * 0.35, ROAD_TOP);
        loose(makeCone(p), p.x, p.z, 0.17, 0.17, 0.6);
      } else if (kind === 4 && k % 4 === 0) {
        const p = at(t, wallC);
        loose(makeCrates({ ...p, seed: 40 + k }), p.x, p.z, 0.45, 0.35, 0.7);
      }
    }

    // A vending machine against the frontage on some segments
    const vendAt = at(a + len * 0.62, outer - side * 0.11);
    if (len > 9 && si % 3 === 0 && !inLaneMouth(vendAt.x, vendAt.z, 0.6, 0.6)) {
      const p = vendAt;
      ctx.add(makeVending({ ...p, ry: faceRoad }));
      const hw = alongX ? 0.5 : 0.4;
      const hd = alongX ? 0.4 : 0.5;
      ctx.collide(p.x - hw, p.z - hd, p.x + hw, p.z + hd, 1.9);
    }

    // Post box + sign on longer runs
    const postAt = at(a + len * 0.3, wallC);
    if (len > 14 && si % 4 === 1 && !inLaneMouth(postAt.x, postAt.z, 0.4, 0.4)) {
      const p = postAt;
      ctx.add(makePostBox({ ...p }));
      ctx.collide(p.x - 0.3, p.z - 0.25, p.x + 0.3, p.z + 0.25, 1.3);
      const q = at(a + len * 0.3 + 2.2, curbC);
      loose(makeSignPost({ ...q, ry: faceRoad }), q.x, q.z, 0.08, 0.08, 2.6);
    }

    // Parked vehicles hugging the kerb — kei trucks, sedans, vans. Sides are
    // staggered, and a car is never parked level with one on the opposite
    // kerb: a facing pair would leave ~0.2 m and wall the street off.
    const key = `${road.axis}${road.c}`;
    if (!parked.has(key)) parked.set(key, []);
    const onRoad = parked.get(key);
    const fracs = side > 0
      ? (len > 26 ? [0.25, 0.68] : len > 12 ? [0.35] : [])
      : (len > 26 ? [0.46, 0.9] : len > 12 ? [0.68] : []);
    fracs.forEach((f, j) => {
      const kind = (si + j) % 3;
      const halfL = kind === 2 ? 1.95 : 1.8;
      const clear = (t) => t - halfL > a + 1.5 && t + halfL < b - 1.5
        && !onRoad.some((o) => Math.abs(o.t - t) < o.halfL + halfL + (o.side === side ? 0.6 : CAR_GAP));
      const base = a + len * f;
      const t = [0, 3, -3, 6, -6].map((d) => base + d).find(clear);
      if (t === undefined) return; // no room without blocking the street
      onRoad.push({ t, halfL, side });
      const p = at(t, inner - side * 0.95, ROAD_TOP);
      const ry = alongX ? (side > 0 ? 0.03 : Math.PI - 0.03) : (side > 0 ? Math.PI / 2 : -Math.PI / 2);
      const colors = [PAL.taxiYellow, PAL.teal, PAL.orange, PAL.blue, PAL.red, PAL.wallWhite];
      const veh = kind === 0
        ? makeKeiTruck({ ...p, ry, hero: si % 8 === 0, color: colors[si % 4], load: si % 3 ? undefined : 'empty' })
        : kind === 1
          ? makeSedan({ ...p, ry, color: colors[(si + 2) % colors.length] })
          : makeVan({ ...p, ry, stripe: colors[(si + 1) % 4] });
      ctx.add(veh);
      const halfW = 0.85;
      const hx = alongX ? halfL : halfW;
      const hz = alongX ? halfW : halfL;
      ctx.collide(p.x - hx, p.z - hz, p.x + hx, p.z + hz, 1.9);
    });
  });

  const runs = [];
  for (const pts of wireRuns.values()) {
    pts.sort((p, q) => (p.x - q.x) || (p.z - q.z));
    // break the run where it jumps across the plaza / a long gap
    let cur = [];
    for (const p of pts) {
      const prev = cur[cur.length - 1];
      if (prev && prev.distanceTo(p) > 16) {
        if (cur.length > 1) runs.push({ points: cur, sag: 0.5 });
        cur = [];
      }
      cur.push(p);
    }
    if (cur.length > 1) runs.push({ points: cur, sag: 0.5 });
  }
  makeWires(ctx, runs);

  // Plaza planters around the edge
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const x = Math.cos(ang) * 7.2;
    const z = Math.sin(ang) * 7.2;
    loose(makePlanter({ x, z, y: 0.12 }), x, z, 0.36, 0.36, 0.75);
  }
  void H;
}
