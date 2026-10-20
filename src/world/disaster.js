import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { rngKit, box } from '../core/util.js';
import { hullOutline } from '../core/outline.js';
import { makeRubble } from './buildings.js';

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
 * - Falling objects: fixed ~2.0s floor-shadow telegraph before impact
 */

const DROP_TELEGRAPH = 2.0;
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
  const drops = []; // { shadow, mesh?, x,z, radius, t0, telegraph, phase, spin, matSize }

  // Pitch-black void materials — fog OFF + toneMapped OFF so grade can't wash them gray
  const voidMat = flat({ color: 0x000000, fog: false, toneMapped: false });
  const voidNearMat = flat({ color: 0x050508, fog: false, toneMapped: false });
  const voidMidMat = flat({ color: 0x0a0a0e, fog: false, toneMapped: false });
  // Bright lip so the hole edge pops against asphalt
  const rimMat = cel({ color: 0xe8e2d8, bands: 3, tint: 0x6a6058 });
  const lipMat = cel({ color: 0xc8c0b4, bands: 2, tint: 0x5a5048 });
  const rubbleMat = cel({ color: PAL.rubble, bands: 3, tint: 0x5a5048 });
  const inkEdge = flat({ color: 0x000000, fog: false, toneMapped: false });
  const shadowMatBase = flat({
    color: 0x050508,
    transparent: true,
    opacity: 0.72,
    fog: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });
  const shadowRimMat = flat({
    color: PAL.danger,
    transparent: true,
    opacity: 0.55,
    fog: false,
    depthWrite: false,
    side: THREE.DoubleSide,
    toneMapped: false,
  });

  function reset() {
    elapsed = 0;
    nextEventAt = 8;
    eventIndex = 0;
    for (const d of debris) world.root.remove(d.mesh);
    debris.length = 0;
    for (const d of drops) {
      if (d.shadow) world.root.remove(d.shadow);
      if (d.mesh) world.root.remove(d.mesh);
    }
    drops.length = 0;
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

  /**
   * Unmistakable black hole in the ground:
   * open pitch-black shaft (fog/grade bypass), stepped walls for depth,
   * bright concrete rim so it reads against asphalt at a glance.
   */
  function makeFissureVisual(w, depth, x, z) {
    const g = new THREE.Group();
    g.position.set(x, 0, z);
    g.name = 'fissure';

    const hw = w * 0.5;
    const hd = depth * 0.5;
    const shaftH = 3.2;

    // Mouth: solid pitch-black lid slightly below road so cut edges don't flash gray
    const mouth = box(w * 1.02, 0.08, depth * 1.02, voidMat, 0, -0.04, 0);
    mouth.receiveShadow = false;
    mouth.castShadow = false;
    g.add(mouth);

    // Open shaft walls (thin boxes lining the pit — you look INTO black)
    const wallT = 0.12;
    const wallY = -shaftH * 0.5;
    const north = box(w + wallT * 2, shaftH, wallT, voidNearMat, 0, wallY, -hd - wallT * 0.5);
    const south = box(w + wallT * 2, shaftH, wallT, voidNearMat, 0, wallY, hd + wallT * 0.5);
    const west = box(wallT, shaftH, depth, voidNearMat, -hw - wallT * 0.5, wallY, 0);
    const east = box(wallT, shaftH, depth, voidNearMat, hw + wallT * 0.5, wallY, 0);
    for (const wall of [north, south, west, east]) {
      wall.receiveShadow = false;
      wall.castShadow = false;
      g.add(wall);
    }

    // Stepped inner ledges (smaller → darker) for vertical depth falloff
    g.add(box(w * 0.88, 0.14, depth * 0.88, voidMidMat, 0, -0.7, 0));
    g.add(box(w * 0.72, 0.14, depth * 0.72, voidNearMat, 0, -1.45, 0));
    g.add(box(w * 0.55, 0.14, depth * 0.55, voidMat, 0, -2.2, 0));

    // Abyss floor — absolute black
    const floor = box(w * 0.95, 0.2, depth * 0.95, voidMat, 0, -shaftH + 0.05, 0);
    floor.receiveShadow = false;
    g.add(floor);

    // Rectangular ink outline flush with road — hard silhouette of the opening
    const edgeH = 0.06;
    const edgeY = 0.035;
    const outline = [
      box(w + 0.28, edgeH, 0.14, inkEdge, 0, edgeY, -hd - 0.06),
      box(w + 0.28, edgeH, 0.14, inkEdge, 0, edgeY, hd + 0.06),
      box(0.14, edgeH, depth + 0.28, inkEdge, -hw - 0.06, edgeY, 0),
      box(0.14, edgeH, depth + 0.28, inkEdge, hw + 0.06, edgeY, 0),
    ];
    for (const e of outline) g.add(e);

    // Bright raised concrete rim — contrast against black void + gray road
    const rimBits = 10 + rng.int(0, 3);
    for (let i = 0; i < rimBits; i++) {
      const t = i / rimBits;
      const ang = t * Math.PI * 2 + rng.range(-0.1, 0.1);
      // Place on the ellipse perimeter of the hole
      const rx = Math.cos(ang) * (hw + rng.range(0.05, 0.22));
      const rz = Math.sin(ang) * (hd + rng.range(0.05, 0.22));
      const bw = rng.range(0.32, 0.62);
      const bd = rng.range(0.26, 0.5);
      const bh = rng.range(0.1, 0.22);
      const chip = box(bw, bh, bd, i % 2 === 0 ? rimMat : lipMat, rx, bh * 0.5, rz);
      chip.rotation.y = ang + rng.range(-0.35, 0.35);
      chip.castShadow = true;
      chip.receiveShadow = true;
      g.add(chip);
      hullOutline(chip, { thickness: 0.0034, color: PAL.ink });
    }

    // Rubble on the lip
    for (let i = 0; i < 5; i++) {
      const ang = rng.range(0, Math.PI * 2);
      const rr = Math.max(hw, hd) + rng.range(0.15, 0.4);
      const s = rng.range(0.14, 0.3);
      const chunk = box(s, s * 0.7, s * 0.85, rubbleMat,
        Math.cos(ang) * rr * (hw / Math.max(hw, hd)),
        s * 0.4,
        Math.sin(ang) * rr * (hd / Math.max(hw, hd)));
      chunk.rotation.set(rng.range(-0.4, 0.4), ang, rng.range(-0.3, 0.3));
      chunk.castShadow = true;
      g.add(chunk);
    }

    return g;
  }

  function spawnFissure() {
    for (let i = 0; i < 16; i++) {
      const spot = pickRoadSpot(4);
      if (!spot) break;
      const { x, z } = spot;
      if (world.holes.some((h) => Math.hypot(h.x - x, h.z - z) < 4)) continue;

      const w = rng.range(2.2, 3.6);
      const d = rng.range(3.0, 5.4);
      const hole = {
        x, z, w, d,
        x0: x - w / 2, x1: x + w / 2,
        z0: z - d / 2, z1: z + d / 2,
      };
      world.holes.push(hole);
      world.cut({ x0: hole.x0, x1: hole.x1, z0: hole.z0, z1: hole.z1, top: -2.5 });
      world.add(makeFissureVisual(w, d, x, z));

      world.juice?.burstDust(x, 0.4, z, 18, 1.2);
      world.juice?.impactRing(x, z, PAL.orange);
      world.onQuake?.(0.45);
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

  /**
   * Core readable hazard: floor shadow ~2s, then object drops from above.
   */
  function spawnFallingDrop(count = 1) {
    let spawned = 0;
    for (let n = 0; n < count; n++) {
      const spot = pickRoadSpot(2.8);
      if (!spot) break;
      const { x, z } = spot;
      const s = rng.range(0.45, 0.95);
      const radius = s * 0.55;

      const shadow = new THREE.Group();
      shadow.position.set(x, 0.05, z);
      const blot = new THREE.Mesh(
        new THREE.CircleGeometry(radius * 1.2, 28),
        shadowMatBase.clone()
      );
      blot.rotation.x = -Math.PI / 2;
      blot.material.opacity = 0.35;
      const rim = new THREE.Mesh(
        new THREE.RingGeometry(radius * 1.05, radius * 1.35, 28),
        shadowRimMat.clone()
      );
      rim.rotation.x = -Math.PI / 2;
      rim.position.y = 0.01;
      rim.material.opacity = 0.35;
      shadow.add(blot);
      shadow.add(rim);
      shadow.scale.setScalar(0.55);
      shadow.userData.blot = blot;
      shadow.userData.rim = rim;
      world.add(shadow);

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
        telegraph: DROP_TELEGRAPH,
        phase: 'warn',
        spin: new THREE.Vector3(rng.range(-5, 5), rng.range(-3, 3), rng.range(-5, 5)),
      });
      spawned += 1;
    }
    if (spawned) {
      world.onQuake?.(0.12);
      if (spawned >= 2) world.onFlash?.('Debris falling!');
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
    if (eventIndex < 2) {
      // First hazards favor readable black holes
      if (roll < 0.72) return spawnFissure();
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

    // Falling objects with floor-shadow telegraph
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const age = elapsed - d.t0;

      if (d.phase === 'warn') {
        const u = Math.min(1, age / d.telegraph);
        // Grow + darken as impact nears (~2s floor telegraph)
        const pulse = 0.94 + Math.sin(elapsed * 11) * 0.06;
        d.shadow.scale.setScalar((0.55 + u * 0.55) * pulse);
        const blot = d.shadow.userData.blot;
        const rim = d.shadow.userData.rim;
        if (blot) blot.material.opacity = 0.5 + u * 0.42;
        if (rim) rim.material.opacity = 0.45 + u * 0.5;
        if (age >= d.telegraph) beginDropFall(d);
        continue;
      }

      if (d.phase === 'fall' && d.mesh) {
        d.mesh.position.y += d.vy * dt;
        d.mesh.rotation.x += d.spin.x * dt;
        d.mesh.rotation.y += d.spin.y * dt;
        d.mesh.rotation.z += d.spin.z * dt;
        const blot = d.shadow.userData.blot;
        const rim = d.shadow.userData.rim;
        if (blot) blot.material.opacity = 0.88;
        if (rim) rim.material.opacity = 0.8;

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
          const rim = d.shadow.userData.rim;
          if (blot) blot.material.opacity = 0.2;
          if (rim) rim.material.opacity = 0.15;
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
