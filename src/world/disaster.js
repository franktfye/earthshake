import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel } from '../core/toon.js';
import { rngKit, box } from '../core/util.js';
import { makeRubble } from './buildings.js';

/**
 * Hazard scheduler — deterministic from seed + room elapsed time.
 * No player-relative picks, so all multiplayer clients share the same quakes.
 */

export function createDisaster(world, opts = {}) {
  const seed = opts.seed ?? 20241019;
  const rng = rngKit(seed + 99);
  const buildings = world.buildings;
  let elapsed = 0;
  let nextEventAt = 18;
  let eventIndex = 0;
  const debris = [];

  function reset() {
    elapsed = 0;
    nextEventAt = 18;
    eventIndex = 0;
    for (const d of debris) world.root.remove(d.mesh);
    debris.length = 0;
  }

  /** Drive clock from shared room time (seconds since room startedAt). */
  function setElapsed(t) {
    elapsed = Math.max(0, t);
  }

  function difficulty() {
    return Math.min(1.35, elapsed / 70);
  }

  function scheduleGap() {
    const d = difficulty();
    return Math.max(2.2, 12 - d * 9) + rng.range(0, 3);
  }

  function spawnFissure() {
    const attempts = 16;
    for (let i = 0; i < attempts; i++) {
      const alongMain = rng.chance(0.55);
      let x, z;
      if (alongMain) {
        x = rng.range(-32, 32);
        z = rng.range(-2.2, 2.2);
      } else {
        x = rng.range(-2.2, 2.2);
        z = rng.range(-32, 32);
      }
      if (world.holes.some((h) => Math.hypot(h.x - x, h.z - z) < 4)) continue;

      const w = rng.range(1.4, 2.6);
      const d = rng.range(2.2, 4.5);
      const hole = {
        x, z, w, d,
        x0: x - w / 2, x1: x + w / 2,
        z0: z - d / 2, z1: z + d / 2,
      };
      world.holes.push(hole);
      world.cut({ x0: hole.x0, x1: hole.x1, z0: hole.z0, z1: hole.z1, top: -2.5 });

      const crack = box(w, 0.35, d, cel({ color: PAL.crack, bands: 2, tint: 0x3a3028 }), x, -0.12, z);
      crack.name = 'fissure';
      world.add(crack);
      world.add(box(w + 0.35, 0.08, d + 0.35, cel({ color: PAL.concreteDark, bands: 3 }), x, 0.08, z));

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

    // debris toward map center — deterministic, shared
    spawnDebris(
      { x: cx, y: b.height * 0.6, z: cz },
      { x: 0, z: 0 },
      b.collapseType === 'pancake' ? 8 : 5,
      b.collapseType === 'facade' ? 9 : 6
    );

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
    // deterministic pick — same index sequence on every client
    const b = living[rng.int(0, living.length - 1)];
    b.pending = true;
    b.pendingAt = elapsed;
    b.telegraph = Math.max(0.55, 1.6 - difficulty() * 0.9);
    b.telegraphT = 0;
    b.baseRotX = b.group.rotation.x;
    b.baseRotZ = b.group.rotation.z;
    world.onQuake?.(0.25);
    world.onFlash?.('Building giving way!');
    return true;
  }

  function fireDueEvents() {
    // catch-up loop for late joiners / frame skips
    let guard = 0;
    while (elapsed >= nextEventAt && guard++ < 40) {
      eventIndex += 1;
      const d = difficulty();
      const roll = rng.next();
      if (roll < 0.4 || eventIndex < 2) spawnFissure();
      else startCollapse();
      if (d > 0.7 && rng.chance(0.35)) {
        if (rng.chance(0.5)) spawnFissure();
        else startCollapse();
      }
      nextEventAt = elapsed + scheduleGap();
    }
    if (elapsed > 20 && world.holes.length === 0 && eventIndex === 0) {
      spawnFissure();
      eventIndex = 1;
      nextEventAt = elapsed + scheduleGap();
    }
  }

  function update(dt, player) {
    // If world.roomElapsed is set by net layer, use shared clock
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
        if (Math.hypot(dx, dy, dz) < d.radius + 0.45) player.kill('debris');
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
        player.kill(z.kind === 'collapse' ? 'collapse' : 'debris');
      }
      if (z.life <= 0) world.collapseZones.splice(i, 1);
    }
  }

  return { update, reset, setElapsed, spawnFissure, startCollapse, get elapsed() { return elapsed; } };
}
