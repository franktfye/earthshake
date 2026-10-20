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

  function burstDust(x, y, z, count = 14, spread = 1) {
    for (let i = 0; i < count; i++) {
      const s = rng.range(0.25, 0.85) * spread;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(s, 6, 5), dustMat.clone());
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
    const geo = new THREE.RingGeometry(0.2, 0.55, 24);
    const mat = flashMat.clone();
    mat.color = new THREE.Color(color);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, 0.12, z);
    world.add(mesh);
    flashes.push({ mesh, life: 0.45, max: 0.45, grow: 4.5 });
  }

  function update(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life -= dt;
      p.vel.y -= 4 * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.material.opacity = Math.max(0, (p.life / p.max) * 0.55);
      p.mesh.scale.multiplyScalar(1 + dt * 0.8);
      if (p.life <= 0) {
        world.root.remove(p.mesh);
        p.mesh.geometry.dispose();
        particles.splice(i, 1);
      }
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i];
      f.life -= dt;
      const t = 1 - f.life / f.max;
      f.mesh.scale.setScalar(1 + t * f.grow);
      f.mesh.material.opacity = (1 - t) * 0.4;
      if (f.life <= 0) {
        world.root.remove(f.mesh);
        f.mesh.geometry.dispose();
        flashes.splice(i, 1);
      }
    }
  }

  return { burstDust, impactRing, update };
}
