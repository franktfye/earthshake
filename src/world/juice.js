import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { flat } from '../core/toon.js';
import { rngKit } from '../core/util.js';

/**
 * Visual juice for quakes / collapses / fissures —
 * dust puffs, light pulse hooks, impact rings (effect language from denser
 * anime Three.js refs: readable bursts, soft particles, brief flashes).
 */
export function createJuice(world) {
  const rng = rngKit(77);
  const dustMat = flat({
    color: 0xd8cfc4,
    transparent: true,
    opacity: 0.55,
    fog: true,
    depthWrite: false,
  });
  const flashMat = flat({
    color: PAL.yellow,
    transparent: true,
    opacity: 0.35,
    fog: false,
    depthWrite: false,
  });

  const particles = [];
  const flashes = [];
  // Late game fires dozens of bursts a second: share geometry, cap the pool,
  // thin bursts when the air is already full, and keep dust off the lens.
  const MAX_DUST = 140;
  const MAX_FLASH = 36;
  const CAM_CLEAR = 4.5;
  const dustGeo = new THREE.SphereGeometry(1, 6, 5);
  const ringGeo = new THREE.RingGeometry(0.2, 0.55, 24);
  const _cam = new THREE.Vector3();

  function retire(list, i) {
    const p = list[i];
    world.root.remove(p.mesh);
    p.mesh.material.dispose();
    list.splice(i, 1);
  }

  function burstDust(x, y, z, count = 14, spread = 1) {
    const room = 1 - particles.length / MAX_DUST;
    const n = Math.max(2, Math.round(count * Math.max(0.15, room)));
    for (let i = 0; i < n; i++) {
      if (particles.length >= MAX_DUST) retire(particles, 0);
      const s = rng.range(0.25, 0.85) * spread;
      const mesh = new THREE.Mesh(dustGeo, dustMat.clone());
      mesh.scale.setScalar(s);
      mesh.material.opacity = rng.range(0.25, 0.6);
      mesh.position.set(
        x + rng.range(-1.2, 1.2) * spread,
        y + rng.range(0.2, 1.5),
        z + rng.range(-1.2, 1.2) * spread
      );
      world.add(mesh);
      particles.push({
        mesh,
        vel: new THREE.Vector3(
          rng.range(-2.5, 2.5),
          rng.range(1.5, 5.5),
          rng.range(-2.5, 2.5)
        ),
        life: rng.range(0.6, 1.4),
        max: 1.2,
      });
    }
  }

  function impactRing(x, z, color = PAL.orange) {
    if (flashes.length >= MAX_FLASH) retire(flashes, 0);
    const mat = flashMat.clone();
    mat.color = new THREE.Color(color);
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.12, z);
    world.add(mesh);
    flashes.push({ mesh, life: 0.45, max: 0.45, grow: 4.5 });
  }

  function update(dt) {
    const cam = world.viewPos ? _cam.copy(world.viewPos) : null;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      p.vel.y -= 4 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      let a = Math.max(0, (p.life / p.max) * 0.55);
      if (cam) {
        // fade out as it nears the camera so a puff can't white out the view
        const d = p.mesh.position.distanceTo(cam) - p.mesh.scale.x;
        a *= Math.min(1, Math.max(0, d / CAM_CLEAR));
      }
      p.mesh.material.opacity = a;
      p.mesh.scale.multiplyScalar(1 + dt * 0.8);
      if (p.life <= 0) retire(particles, i);
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.life -= dt;
      const t = 1 - f.life / f.max;
      f.mesh.scale.setScalar(1 + t * f.grow);
      f.mesh.material.opacity = (1 - t) * 0.4;
      if (f.life <= 0) retire(flashes, i);
    }
  }

  return { burstDust, impactRing, update };
}
