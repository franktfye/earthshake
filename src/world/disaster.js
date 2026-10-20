import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { rngKit, box } from '../core/util.js';
import { hullOutline } from '../core/outline.js';
import { makeRubble } from './buildings.js';
import { getPunchableGroundMats } from './street.js';
import { patchGroundMaterial, setHolePunches, clearHolePunches } from './holePunch.js';

/**
 * Hazard scheduler — deterministic from seed + room elapsed time.
 * No player-relative picks, so all multiplayer clients share the same quakes.
 *
 * Difficulty knobs (challenging curve):
 * - First event ~8s (was ~18s)
 * - Difficulty ramps by ~42s (was ~70s)
 * - Event gap max(1.35, 6.5 − d×4.5) + jitter (was 12 − d×9)
 * - Higher overlap: secondary + tertiary hazards more often
 * - Collapse telegraph max(0.8, 1.3 − d×0.55)s (tighter, still ≥0.8s)
 * - Hazard ground warning circle: 1.0s before impact / crack open
 * - Ground cracks despawn after 60s (shared room elapsed)
 */

const WARN_TELEGRAPH = 1.0;
const HOLE_LIFETIME = 60;
const FALL_HEIGHT = 14;
const FALL_SPEED = 22;

export function createDisaster(world, opts = {}) {
  const seed = opts.seed ?? 20241019;
  const rng = rngKit(seed + 99);
  const buildings = world.buildings;
  let elapsed = 0;
  let nextEventAt = 5; // first readable hazard sooner
  let eventIndex = 0;
  const debris = [];
  const drops = []; // { shadow, mesh?, x,z, radius, t0, telegraph, phase, ... }
  const pendingFissures = []; // { outline, x, z, t0, warnMesh, holeId }
  let holeSeq = 0;
  const holeMeshes = new Map(); // holeId → group

  // Pitch-black void — unlit, no fog. Grade also crushes near-black → #000.
  const voidMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  // Slightly lifted black for shaft walls so ink/depth edges read (still crushed by grade)
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    fog: false,
    toneMapped: false,
    side: THREE.DoubleSide,
  });
  // Bright lip — only non-black part of the crater
  const rimMat = cel({ color: 0xf0ebe3, bands: 3, tint: 0x6a6058 });
  const lipMat = cel({ color: 0xd4cdc2, bands: 2, tint: 0x5a5048 });
  const rubbleMat = cel({ color: PAL.rubble, bands: 3, tint: 0x5a5048 });

  // Punch asphalt / dirt so the open funnel is actually visible
  for (const mat of getPunchableGroundMats()) patchGroundMaterial(mat);

  function circleHitsAabb(hx, hz, hr, tx, tz, hw, hd) {
    const cx = Math.min(Math.max(hx, tx - hw), tx + hw);
    const cz = Math.min(Math.max(hz, tz - hd), tz + hd);
    const dx = hx - cx;
    const dz = hz - cz;
    return dx * dx + dz * dz < hr * hr;
  }

  function syncGroundPunches() {
    const list = [];
    for (const h of world.holes) {
      const r = h.punchR ?? Math.max(h.w, h.d) * 0.55;
      list.push({ x: h.x, z: h.z, radius: r });
    }
    setHolePunches(list);
    // Detach road/dirt/line tiles under fissures (visible=false alone was unreliable)
    const tiles = world.punchTiles || [];
    let hidden = 0;
    for (const t of tiles) {
      const hw = t.hw ?? 1;
      const hd = t.hd ?? 1;
      let hide = false;
      for (const h of list) {
        if (circleHitsAabb(h.x, h.z, h.radius, t.x, t.z, hw, hd)) {
          hide = true;
          break;
        }
      }
      if (hide) {
        hidden += 1;
        t.mesh.visible = false;
        t.mesh.scale.setScalar(0.001);
        if (t.mesh.parent) {
          t.parent = t.mesh.parent;
          t.mesh.parent.remove(t.mesh);
        }
      } else {
        t.mesh.visible = true;
        t.mesh.scale.setScalar(1);
        if (t.parent && !t.mesh.parent) t.parent.add(t.mesh);
        t.parent = null;
      }
    }
    if (typeof window !== 'undefined') {
      window.__aftershockHoles = { count: list.length, tiles: tiles.length, hidden };
    }
  }
  // Falling-object warning: dark ground SHADOW (required), optional thin danger ring
  const shadowMatBase = flat({
    color: 0x000000,
    transparent: true,
    opacity: 0.88,
    fog: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const shadowRimMat = flat({
    color: PAL.danger,
    transparent: true,
    opacity: 0.4,
    fog: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  function reset() {
    elapsed = 0;
    nextEventAt = 5;
    eventIndex = 0;
    holeSeq = 0;
    for (const d of debris) world.root.remove(d.mesh);
    debris.length = 0;
    for (const d of drops) {
      if (d.shadow) world.root.remove(d.shadow);
      if (d.mesh) world.root.remove(d.mesh);
    }
    drops.length = 0;
    for (const pf of pendingFissures) {
      if (pf.warnMesh) world.root.remove(pf.warnMesh);
    }
    pendingFissures.length = 0;
    for (const mesh of holeMeshes.values()) world.root.remove(mesh);
    holeMeshes.clear();
    world.holes.length = 0;
    clearHolePunches();
    for (const t of world.punchTiles || []) {
      t.mesh.visible = true;
      t.mesh.scale.setScalar(1);
      if (t.parent && !t.mesh.parent) t.parent.add(t.mesh);
      t.parent = null;
    }
  }

  /**
   * 1s telegraph:
   * - Falling debris: dark filled ground SHADOW (required).
   * - Crack warn: ring only (not a filled disc — that was mistaken for a flat hole).
   */
  function makeWarnShadow(x, z, radius, { crack = false } = {}) {
    const g = new THREE.Group();
    g.position.set(x, 0.055, z);
    if (crack) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.72, radius * 1.08, 48),
        shadowRimMat.clone()
      );
      ring.rotation.x = -Math.PI / 2;
      ring.material.opacity = 0.7;
      const inner = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.35, radius * 0.55, 40),
        shadowMatBase.clone()
      );
      inner.rotation.x = -Math.PI / 2;
      inner.position.y = 0.008;
      inner.material.opacity = 0.35;
      g.add(ring);
      g.add(inner);
      g.userData.blot = inner;
      g.userData.soft = ring;
      g.userData.rim = ring;
      world.add(g);
      return g;
    }
    const blot = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 36),
      shadowMatBase.clone()
    );
    blot.rotation.x = -Math.PI / 2;
    blot.material.opacity = 0.78;
    const soft = new THREE.Mesh(
      new THREE.CircleGeometry(radius * 1.25, 36),
      shadowMatBase.clone()
    );
    soft.rotation.x = -Math.PI / 2;
    soft.position.y = -0.005;
    soft.material.opacity = 0.38;
    const rim = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.05, radius * 1.22, 36),
      shadowRimMat.clone()
    );
    rim.rotation.x = -Math.PI / 2;
    rim.position.y = 0.012;
    rim.material.opacity = 0.35;
    g.add(soft);
    g.add(blot);
    g.add(rim);
    g.userData.blot = blot;
    g.userData.soft = soft;
    g.userData.rim = rim;
    world.add(g);
    return g;
  }

  function removeHole(hole) {
    if (!hole) return;
    const idx = world.holes.indexOf(hole);
    if (idx >= 0) world.holes.splice(idx, 1);
    if (hole.id != null && holeMeshes.has(hole.id)) {
      world.root.remove(holeMeshes.get(hole.id));
      holeMeshes.delete(hole.id);
    }
    syncGroundPunches();
  }

  function setElapsed(t) {
    elapsed = Math.max(0, t);
  }

  function difficulty() {
    return Math.min(1.45, elapsed / 42);
  }

  function scheduleGap() {
    const d = difficulty();
    return Math.max(1.35, 6.5 - d * 4.5) + rng.range(0, 1.6);
  }

  function pickRoadSpot(minHoleDist = 3.2) {
    for (let i = 0; i < 22; i++) {
      const alongMain = rng.chance(0.58);
      let x, z;
      if (alongMain) {
        x = rng.range(-30, 30);
        z = rng.range(-2.4, 2.4);
      } else {
        x = rng.range(-2.4, 2.4);
        z = rng.range(-30, 30);
      }
      if (world.holes.some((h) => Math.hypot(h.x - x, h.z - z) < minHoleDist)) continue;
      if (drops.some((d) => Math.hypot(d.x - x, d.z - z) < 2.4)) continue;
      return { x, z };
    }
    return null;
  }

  /** Point-in-polygon (xz), local coords relative to hole center. */
  function pointInPoly(px, pz, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i].x, zi = pts[i].z;
      const xj = pts[j].x, zj = pts[j].z;
      const hit = ((zi > pz) !== (zj > pz))
        && (px < (xj - xi) * (pz - zi) / ((zj - zi) || 1e-9) + xi);
      if (hit) inside = !inside;
    }
    return inside;
  }

  /**
   * Smooth silhouette: circle (Cylinder) or organic blob (high-seg radial).
   * Organic uses low-frequency harmonics only — no per-point jitter (avoids stairsteps).
   */
  function makeHoleOutline() {
    const kind = rng.chance(0.55) ? 'circle' : 'organic';
    const baseR = rng.range(2.15, 3.35); // larger — depth reads from third-person
    const rxScale = kind === 'circle' ? 1 : rng.range(0.85, 1.2);
    const rzScale = kind === 'circle' ? 1 : rng.range(0.85, 1.2);
    const n = 48; // enough segments to read smooth from third-person
    // Organic lobes: 2–3 smooth sine modes (fixed coeffs for this hole)
    const a1 = rng.range(0.08, 0.18);
    const a2 = rng.range(0.04, 0.12);
    const a3 = rng.range(0.0, 0.07);
    const p1 = rng.range(0, Math.PI * 2);
    const p2 = rng.range(0, Math.PI * 2);
    const p3 = rng.range(0, Math.PI * 2);
    const k1 = rng.pick([2, 3]);
    const k2 = rng.pick([3, 4, 5]);
    const k3 = rng.pick([5, 6, 7]);

    const pts = [];
    let maxR = 0;
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2;
      let r = baseR;
      if (kind === 'organic') {
        r *= 1
          + a1 * Math.sin(k1 * ang + p1)
          + a2 * Math.sin(k2 * ang + p2)
          + a3 * Math.sin(k3 * ang + p3);
      }
      const px = Math.cos(ang) * r * rxScale;
      const pz = Math.sin(ang) * r * rzScale;
      maxR = Math.max(maxR, Math.hypot(px, pz));
      pts.push({ x: px, z: pz });
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    return { kind, pts, baseR, maxR, rxScale, rzScale, minX, maxX, minZ, maxZ, n };
  }

  function shapeFromPts(pts, scale = 1) {
    const shape = new THREE.Shape();
    shape.moveTo(pts[0].x * scale, pts[0].z * scale);
    for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x * scale, pts[i].z * scale);
    shape.closePath();
    return shape;
  }

  function extrudedDisc(pts, scale, height, mat, y) {
    const geo = new THREE.ExtrudeGeometry(shapeFromPts(pts, scale), {
      depth: height,
      bevelEnabled: false,
      curveSegments: 1,
      steps: 1,
    });
    geo.rotateX(Math.PI / 2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = y;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    return mesh;
  }

  /** Smooth vertical tube walls from outline (many thin segments ≈ continuous cylinder). */
  function addSmoothShaft(g, pts, scale, shaftH, mat) {
    const n = pts.length;
    const thick = 0.18;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const ax = a.x * scale, az = a.z * scale;
      const bx = b.x * scale, bz = b.z * scale;
      const dx = bx - ax, dz = bz - az;
      const len = Math.hypot(dx, dz) || 0.01;
      // Slightly overlap segments so facets don't show gaps
      const wall = box(len * 1.08, shaftH, thick, mat, (ax + bx) / 2, -shaftH * 0.5, (az + bz) / 2);
      wall.rotation.y = Math.atan2(dx, dz);
      wall.castShadow = false;
      wall.receiveShadow = true;
      g.add(wall);
    }
  }

  /** Soft concrete lip: short cylinders / torus-ish chips, not boxy right angles. */
  function addSmoothRim(g, outline) {
    const { pts, maxR, kind } = outline;
    if (kind === 'circle') {
      // Continuous ring via thin torus
      const torus = new THREE.Mesh(
        new THREE.TorusGeometry(outline.baseR * 1.02, 0.11, 8, 48),
        rimMat
      );
      torus.rotation.x = Math.PI / 2;
      torus.position.y = 0.1;
      torus.castShadow = true;
      torus.receiveShadow = true;
      g.add(torus);
      hullOutline(torus, { thickness: 0.0028, color: PAL.ink });
      return;
    }
    // Organic: many small cylinders along perimeter (reads as soft rubble lip)
    const count = 36;
    for (let i = 0; i < count; i++) {
      const p = pts[Math.floor((i / count) * pts.length) % pts.length];
      const len = Math.hypot(p.x, p.z) || 1;
      const ox = (p.x / len) * (len + 0.12);
      const oz = (p.z / len) * (len + 0.12);
      const r = rng.range(0.1, 0.18);
      const h = rng.range(0.1, 0.18);
      const chip = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r * 0.9, h, 8),
        i % 2 === 0 ? rimMat : lipMat
      );
      chip.position.set(ox, h * 0.45, oz);
      chip.castShadow = true;
      chip.receiveShadow = true;
      g.add(chip);
    }
    void maxR;
  }

  /**
   * Organic bowl: scaled outline rings at depths → continuous funnel you look into.
   * Road is shader-punched; sloping walls are what you see.
   */
  function makeOrganicBowl(pts, mat) {
    const rings = [
      { s: 1.08, y: 0.18 },
      { s: 1.0, y: 0.06 },
      { s: 0.94, y: -0.2 },
      { s: 0.84, y: -0.85 },
      { s: 0.7, y: -1.7 },
      { s: 0.55, y: -2.7 },
      { s: 0.4, y: -3.7 },
      { s: 0.28, y: -4.35 },
      { s: 0.02, y: -4.5 },
    ];
    const n = pts.length;
    const positions = [];
    const indices = [];
    for (let r = 0; r < rings.length; r++) {
      const { s, y } = rings[r];
      for (let i = 0; i < n; i++) {
        positions.push(pts[i].x * s, y, pts[i].z * s);
      }
    }
    for (let r = 0; r < rings.length - 1; r++) {
      for (let i = 0; i < n; i++) {
        const i0 = r * n + i;
        const i1 = r * n + ((i + 1) % n);
        const j0 = (r + 1) * n + i;
        const j1 = (r + 1) * n + ((i + 1) % n);
        // inward-facing (look into pit)
        indices.push(i0, i1, j0);
        indices.push(i1, j1, j0);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Deep OPEN black crater. Road/dirt tiles are hidden under the footprint so
   * third-person looks into sloping black walls (wide bowl = lots of wall pixels).
   * Concrete inner ledges make depth unmistakable. No flat black lid.
   */
  function makeFissureVisual(outline, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.name = 'fissure';
    const { pts, kind, baseR } = outline;
    const segs = 64;

    if (kind === 'circle') {
      // Wide lathe bowl + vertical well
      const profile = [
        new THREE.Vector2(baseR + 0.4, 0.28),
        new THREE.Vector2(baseR * 1.06, 0.16),
        new THREE.Vector2(baseR * 1.0, 0.02),
        new THREE.Vector2(baseR * 0.92, -0.35),
        new THREE.Vector2(baseR * 0.78, -0.95),
        new THREE.Vector2(baseR * 0.62, -1.7),
        new THREE.Vector2(baseR * 0.48, -2.6),
        new THREE.Vector2(baseR * 0.34, -3.7),
        new THREE.Vector2(baseR * 0.22, -4.6),
        new THREE.Vector2(0.03, -4.75),
      ];
      g.add(new THREE.Mesh(new THREE.LatheGeometry(profile, segs), shaftMat));

      const well = new THREE.Mesh(
        new THREE.CylinderGeometry(baseR * 0.9, baseR * 0.3, 4.6, segs, 1, true),
        shaftMat
      );
      well.position.y = -2.15;
      g.add(well);

      // Stacked black discs — fill every view ray so fog/clear never shows as “grey road”
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const y = -0.12 - t * 4.5;
        const r = baseR * (0.98 - t * 0.72);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(Math.max(0.12, r), segs), voidMat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.y = y;
        g.add(disc);
      }

      // Concrete ledges inside (depth you can count)
      for (const [ry, yy, tube] of [[0.82, -0.5, 0.09], [0.58, -1.55, 0.08], [0.38, -2.9, 0.07]]) {
        const ledge = new THREE.Mesh(
          new THREE.TorusGeometry(baseR * ry, tube, 8, segs),
          lipMat
        );
        ledge.rotation.x = Math.PI / 2;
        ledge.position.y = yy;
        g.add(ledge);
      }
    } else {
      g.add(makeOrganicBowl(pts, shaftMat));
      addSmoothShaft(g, pts, 0.95, 4.2, shaftMat);
      addSmoothShaft(g, pts, 0.65, 3.4, shaftMat);
      for (let i = 0; i < 7; i++) {
        const t = i / 6;
        g.add(extrudedDisc(pts, 0.95 - t * 0.65, 0.08, voidMat, -0.15 - t * 4.2));
      }
      g.add(extrudedDisc(pts, 0.78, 0.1, lipMat, -0.5));
      g.add(extrudedDisc(pts, 0.52, 0.09, lipMat, -1.55));
    }

    g.traverse((o) => {
      if (o.isMesh) o.renderOrder = 2;
    });
    addSmoothRim(g, outline);

    for (let i = 0; i < 5; i++) {
      const p = pts[rng.int(0, pts.length - 1)];
      const len = Math.hypot(p.x, p.z) || 1;
      const s = rng.range(0.12, 0.24);
      const chunk = new THREE.Mesh(
        new THREE.CylinderGeometry(s, s * 0.85, s * 1.1, 7),
        rubbleMat
      );
      chunk.position.set(
        (p.x / len) * (len + rng.range(0.3, 0.6)),
        s * 0.45,
        (p.z / len) * (len + rng.range(0.3, 0.6))
      );
      chunk.castShadow = true;
      g.add(chunk);
    }

    return g;
  }

  function openFissure(outline, x, z) {
    const id = ++holeSeq;
      const punchR = outline.maxR * 1.2; // slightly oversized so tiles fully clear
    const hole = {
      id, x, z,
      kind: outline.kind,
      pts: outline.pts,
      punchR,
      bottom: -4.0,
      spawnedAt: elapsed,
      expiresAt: elapsed + HOLE_LIFETIME,
      w: outline.maxX - outline.minX,
      d: outline.maxZ - outline.minZ,
      x0: x + outline.minX,
      x1: x + outline.maxX,
      z0: z + outline.minZ,
      z1: z + outline.maxZ,
      contains(px, pz) {
        if (outline.kind === 'circle') {
          const dx = px - x;
          const dz = pz - z;
          return (dx * dx + dz * dz) <= outline.baseR * outline.baseR;
        }
        return pointInPoly(px - x, pz - z, outline.pts);
      },
    };
    world.holes.push(hole);
    const mesh = makeFissureVisual(outline, x, z);
    world.add(mesh);
    holeMeshes.set(id, mesh);
    syncGroundPunches();
    world.juice?.burstDust(x, 0.4, z, 18, 1.2);
    world.juice?.impactRing(x, z, PAL.orange);
    world.onQuake?.(0.45);
    return hole;
  }

  /** Queue fissure with 1s warning circle, then open. */
  function spawnFissure() {
    for (let i = 0; i < 16; i++) {
      const spot = pickRoadSpot(4);
      if (!spot) break;
      const { x, z } = spot;
      if (world.holes.some((h) => Math.hypot(h.x - x, h.z - z) < 4)) continue;
      if (pendingFissures.some((p) => Math.hypot(p.x - x, p.z - z) < 4)) continue;

      const outline = makeHoleOutline();
      const warnR = outline.maxR * 1.05;
      const warnMesh = makeWarnShadow(x, z, warnR, { crack: true });
      pendingFissures.push({
        outline, x, z, t0: elapsed, telegraph: WARN_TELEGRAPH, warnMesh,
      });
      world.onQuake?.(0.1);
      world.onFlash?.('Ground cracking!');
      return true;
    }
    return false;
  }

  function spawnDebris(from, toward, count, speed = 6) {
    const mat = cel({ color: PAL.rubble, bands: 3, tint: 0x5a5048 });
    for (let i = 0; i < count; i++) {
      const s = rng.range(0.25, 0.7);
      const mesh = box(s, s * 0.7, s * 0.8, mat, from.x, from.y, from.z);
      mesh.castShadow = true;
      world.add(mesh);
      const dir = new THREE.Vector3(
        toward.x - from.x + rng.range(-2, 2),
        rng.range(2, 5),
        toward.z - from.z + rng.range(-2, 2)
      ).normalize();
      debris.push({
        mesh,
        vel: dir.multiplyScalar(speed * rng.range(0.7, 1.2)),
        life: rng.range(1.8, 3.2),
        spin: new THREE.Vector3(rng.range(-4, 4), rng.range(-4, 4), rng.range(-4, 4)),
        radius: s * 0.45,
      });
    }
  }

  /** Dark ground shadow for 1s, then object drops from above. */
  function spawnFallingDrop(count = 1) {
    let spawned = 0;
    for (let n = 0; n < count; n++) {
      const spot = pickRoadSpot(2.8);
      if (!spot) break;
      const { x, z } = spot;
      const s = rng.range(0.45, 0.95);
      const radius = s * 0.85;
      const shadow = makeWarnShadow(x, z, radius * 1.15);
      shadow.scale.setScalar(0.85);

      const mat = cel({
        color: rng.pick([PAL.rubble, PAL.concreteDark, PAL.concreteMid, 0x6a6058]),
        bands: 3,
        tint: 0x4a4038,
      });

      drops.push({
        x, z, radius, s, mat,
        shadow,
        mesh: null,
        t0: elapsed,
        telegraph: WARN_TELEGRAPH,
        phase: 'warn',
        spin: new THREE.Vector3(rng.range(-5, 5), rng.range(-3, 3), rng.range(-5, 5)),
      });
      spawned += 1;
    }
    if (spawned) {
      world.onQuake?.(0.12);
      if (spawned >= 1) world.onFlash?.('Debris falling!');
    }
    return spawned > 0;
  }

  function beginDropFall(d) {
    const mesh = box(d.s, d.s * 0.75, d.s * 0.85, d.mat, d.x, FALL_HEIGHT, d.z);
    mesh.castShadow = true;
    mesh.rotation.set(rng.range(0, 1), rng.range(0, 2), rng.range(0, 1));
    world.add(mesh);
    d.mesh = mesh;
    d.phase = 'fall';
    d.vy = -FALL_SPEED * rng.range(0.9, 1.15);
    world.onQuake?.(0.18); // camera nudge as object commits
  }

  function collapseBuilding(b) {
    if (b.collapsed) return false;
    b.collapsed = true;
    b.pending = false;
    const fp = b.footprint;
    const cx = (fp.x0 + fp.x1) / 2;
    const cz = (fp.z0 + fp.z1) / 2;

    world.root.remove(b.group);
    world.colliders = world.colliders.filter((c) => c.ref !== b);
    world.add(makeRubble(fp, b.height, seed + eventIndex * 17));
    world.collide(fp.x0 + 0.3, fp.z0 + 0.3, fp.x1 - 0.3, fp.z1 - 0.3, 1.1, undefined, b);

    spawnDebris(
      { x: cx, y: b.height * 0.6, z: cz },
      { x: 0, z: 0 },
      b.collapseType === 'pancake' ? 10 : 6,
      b.collapseType === 'facade' ? 10 : 7
    );
    // Extra sky-drops near the collapse footprint (with shadows)
    spawnFallingDrop(1 + (difficulty() > 0.5 ? 1 : 0));

    world.collapseZones.push({
      x0: fp.x0 - 0.4, x1: fp.x1 + 0.4,
      z0: fp.z0 - 0.4, z1: fp.z1 + 0.4,
      life: 0.85,
      kind: 'collapse',
    });

    world.juice?.burstDust(cx, b.height * 0.4, cz, 28, 1.6);
    world.juice?.impactRing(cx, cz, PAL.red);
    world.onQuake?.(0.85);
    return true;
  }

  function startCollapse() {
    const living = buildings.filter((b) => !b.collapsed && !b.pending);
    if (!living.length) return false;
    const b = living[rng.int(0, living.length - 1)];
    b.pending = true;
    b.pendingAt = elapsed;
    b.telegraph = Math.max(0.8, 1.3 - difficulty() * 0.55);
    b.telegraphT = 0;
    b.baseRotX = b.group.rotation.x;
    b.baseRotZ = b.group.rotation.z;
    world.onQuake?.(0.25);
    world.onFlash?.('Building giving way!');
    return true;
  }

  function fireOneHazard() {
    const d = difficulty();
    const roll = rng.next();
    // Weight toward falling drops mid/late; fissures early; collapses sprinkled
    if (eventIndex <= 1) {
      // First hazard is always a black hole so it is unmistakable
      return spawnFissure();
    }
    if (eventIndex === 2) {
      if (roll < 0.55) return spawnFissure();
      return spawnFallingDrop(1);
    }
    if (roll < 0.34) return spawnFallingDrop(1 + (d > 0.55 && rng.chance(0.55) ? 1 : 0));
    if (roll < 0.62) return spawnFissure();
    return startCollapse();
  }

  function fireDueEvents() {
    let guard = 0;
    while (elapsed >= nextEventAt && guard++ < 48) {
      eventIndex += 1;
      const d = difficulty();
      fireOneHazard();
      // Overlap: secondary hazard often
      if (d > 0.25 && rng.chance(0.42 + d * 0.28)) fireOneHazard();
      // Tertiary sky-drops when hot
      if (d > 0.55 && rng.chance(0.4)) spawnFallingDrop(1 + (rng.chance(0.4) ? 1 : 0));
      nextEventAt = elapsed + scheduleGap();
    }
    // Safety: something must happen early if clock was jumped
    if (elapsed > 10 && world.holes.length === 0 && drops.length === 0 && eventIndex === 0) {
      spawnFissure();
      spawnFallingDrop(1);
      eventIndex = 1;
      nextEventAt = elapsed + scheduleGap();
    }
  }

  function update(dt, player) {
    if (typeof world.roomElapsed === 'number') {
      setElapsed(world.roomElapsed);
    } else {
      elapsed += dt;
    }

    fireDueEvents();
    // Keep asphalt cut open every frame (tiles can be re-added by rebuilds)
    if (world.holes.length) syncGroundPunches();

    for (const b of buildings) {
      if (!b.pending || b.collapsed) continue;
      b.telegraphT = elapsed - (b.pendingAt ?? elapsed);
      const t = Math.min(1, b.telegraphT / b.telegraph);
      const shake = Math.sin(elapsed * 28) * 0.025 * Math.min(1, t * 2);
      if (b.group) {
        if (b.collapseType === 'lean') {
          b.group.rotation.z = (b.baseRotZ || 0) + shake * 3 + t * 0.08;
        } else if (b.collapseType === 'facade') {
          b.group.rotation.x = (b.baseRotX || 0) + shake * 2 + t * 0.05;
        } else {
          b.group.position.y = Math.sin(elapsed * 22) * 0.04 * t;
        }
      }
      if (b.telegraphT >= b.telegraph) collapseBuilding(b);
    }

    // Pending fissures: 1s warning circle then open
    for (let i = pendingFissures.length - 1; i >= 0; i--) {
      const pf = pendingFissures[i];
      const age = elapsed - pf.t0;
      const u = Math.min(1, age / pf.telegraph);
      const pulse = 0.92 + Math.sin(elapsed * 14) * 0.08;
      if (pf.warnMesh) {
        pf.warnMesh.scale.setScalar((0.7 + u * 0.4) * pulse);
        const blot = pf.warnMesh.userData.blot;
        const soft = pf.warnMesh.userData.soft;
        if (blot) blot.material.opacity = 0.45 + u * 0.4;
        if (soft) soft.material.opacity = 0.22 + u * 0.25;
      }
      if (age >= pf.telegraph) {
        if (pf.warnMesh) world.root.remove(pf.warnMesh);
        openFissure(pf.outline, pf.x, pf.z);
        pendingFissures.splice(i, 1);
      }
    }

    // Despawn cracks after 1 minute (shared room elapsed)
    for (let i = world.holes.length - 1; i >= 0; i--) {
      const h = world.holes[i];
      if (h.expiresAt != null && elapsed >= h.expiresAt) {
        removeHole(h);
      }
    }

    // Falling objects with 1s floor-warning circle
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const age = elapsed - d.t0;

      if (d.phase === 'warn') {
        const u = Math.min(1, age / d.telegraph);
        const pulse = 0.94 + Math.sin(elapsed * 14) * 0.06;
        d.shadow.scale.setScalar((0.85 + u * 0.25) * pulse);
        const blot = d.shadow.userData.blot;
        const soft = d.shadow.userData.soft;
        const rim = d.shadow.userData.rim;
        if (blot) blot.material.opacity = 0.65 + u * 0.28;
        if (soft) soft.material.opacity = 0.3 + u * 0.25;
        if (rim) rim.material.opacity = 0.3 + u * 0.25;
        if (age >= d.telegraph) beginDropFall(d);
        continue;
      }

      if (d.phase === 'fall' && d.mesh) {
        d.mesh.position.y += d.vy * dt;
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.mesh.rotation.z += d.spin.z * dt;
        const blot = d.shadow.userData.blot;
        const soft = d.shadow.userData.soft;
        const rim = d.shadow.userData.rim;
        if (blot) blot.material.opacity = 0.9;
        if (soft) soft.material.opacity = 0.45;
        if (rim) rim.material.opacity = 0.55;

        if (player.alive) {
          const dx = d.mesh.position.x - player.pos.x;
          const dy = d.mesh.position.y - (player.pos.y + 1.0);
          const dz = d.mesh.position.z - player.pos.z;
        if (Math.hypot(dx, dy, dz) < d.radius + 0.5) {
          player.takeHit('debris', {
            kx: (player.pos.x - d.x) * 3,
            kz: (player.pos.z - d.z) * 3,
          });
        }
      }

        if (d.mesh.position.y <= d.s * 0.4) {
          d.mesh.position.y = d.s * 0.35;
          // Impact squash + juice
          d.mesh.scale.set(1.35, 0.55, 1.35);
          d.squash = 0.55;
          world.juice?.burstDust(d.x, 0.35, d.z, 16, 1.25);
          world.juice?.impactRing(d.x, d.z, PAL.danger);
          world.onQuake?.(0.42);
          if (player.alive) {
            const dx = d.x - player.pos.x;
            const dz = d.z - player.pos.z;
            if (Math.hypot(dx, dz) < d.radius + 0.55) {
              player.takeHit('debris', { kx: dx * -2.5, kz: dz * -2.5 });
            }
          }
          d.phase = 'done';
          d.doneAt = elapsed;
          const blot = d.shadow.userData.blot;
          const soft = d.shadow.userData.soft;
          const rim = d.shadow.userData.rim;
          if (blot) blot.material.opacity = 0.2;
          if (soft) soft.material.opacity = 0.1;
          if (rim) rim.material.opacity = 0.12;
        }
      }

      if (d.phase === 'done' && elapsed - (d.doneAt || elapsed) > 2.2) {
        if (d.shadow) world.root.remove(d.shadow);
        if (d.mesh) world.root.remove(d.mesh);
        drops.splice(i, 1);
      }
    }

    const pos = player.pos;
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.life -= dt;
      d.vel.y -= 14 * dt;
      d.mesh.position.x += d.vel.x * dt;
      d.mesh.position.y += d.vel.y * dt;
      d.mesh.position.z += d.vel.z * dt;
      d.mesh.rotation.x += d.spin.x * dt;
      d.mesh.rotation.y += d.spin.y * dt;
      d.mesh.rotation.z += d.spin.z * dt;

      if (player.alive) {
        const dx = d.mesh.position.x - pos.x;
        const dy = d.mesh.position.y - (pos.y + 1.0);
        const dz = d.mesh.position.z - pos.z;
        if (Math.hypot(dx, dy, dz) < d.radius + 0.45) {
          player.takeHit('debris', {
            kx: (pos.x - d.mesh.position.x) * 2.5,
            kz: (pos.z - d.mesh.position.z) * 2.5,
          });
        }
      }
      if (d.life <= 0 || d.mesh.position.y < -1) {
        world.root.remove(d.mesh);
        debris.splice(i, 1);
      }
    }

    for (let i = world.collapseZones.length - 1; i >= 0; i--) {
      const z = world.collapseZones[i];
      z.life -= dt;
      if (player.alive &&
          pos.x > z.x0 && pos.x < z.x1 &&
          pos.z > z.z0 && pos.z < z.z1) {
        player.takeHit(z.kind === 'collapse' ? 'collapse' : 'debris', { shake: 1.1 });
      }
      if (z.life <= 0) world.collapseZones.splice(i, 1);
    }
  }

  return {
    update, reset, setElapsed, spawnFissure, startCollapse, spawnFallingDrop,
    get elapsed() { return elapsed; },
  };
}
