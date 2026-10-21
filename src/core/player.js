import * as THREE from 'three';
import { clamp } from './util.js';
import { createCharacter } from '../world/character.js';

const RADIUS = 0.38;
const STEP = 0.38;
const CAM_DIST = 5.2;
const CAM_HEIGHT = 2.35;
const CAM_LOOK = 1.15;
/** Jump launch speed / gravity → ~0.95 m apex, ~0.7 s airtime. */
const JUMP_V = 5.4;
const JUMP_G = 15;

/** Third-person walker with stylized human mesh + energy. */
export class Player {
  constructor(camera, domElement, world, controls, opts = {}) {
    this.camera = camera;
    this.dom = domElement;
    this.world = world;
    this.controls = controls;

    this.spawn = {
      pos: new THREE.Vector3(opts.x ?? 0, 0, opts.z ?? 8),
      yaw: opts.yaw ?? 0.15,
      pitch: opts.pitch ?? 0.28,
    };

    this.pos = this.spawn.pos.clone();
    this.yaw = this.spawn.yaw;
    this.pitch = this.spawn.pitch;
    this.vel = new THREE.Vector3();
    this.bob = 0;
    this.walkSpeed = 2.55;
    this.runSpeed = 5.1;
    this.sensitivity = 0.0024;

    this.energy = 1;
    this.maxEnergy = 1;
    this.maxLives = 3;
    this.lives = this.maxLives;
    this.exhausted = false;
    this.alive = true;
    this.playing = false;
    this.facing = this.yaw;
    this.invuln = 0;

    this.drainWalk = 0; // walking does not drain — regenerates like standing
    this.drainRun = 0.12;
    this.regenWalk = 0.09; // recharge while walking / idle (anything except sprint)
    this.regenStill = 0.09;

    this.shake = 0;
    this.hitFlash = 0;
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._wish = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._lookAt = new THREE.Vector3();
    this._smoothCam = new THREE.Vector3();
    this._camReady = false;

    this.character = createCharacter();
    // Parent to scene so world rebuilds don't destroy the avatar
    this._scene = world.root.parent;
    if (this._scene) this._scene.add(this.character.root);
    else world.root.add(this.character.root);

    // soft foot ring (presence marker — readable character locus)
    const ringGeo = new THREE.RingGeometry(0.32, 0.42, 32);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xf4c033,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.footRing = new THREE.Mesh(ringGeo, ringMat);
    this.footRing.rotation.x = -Math.PI / 2;
    this.footRing.position.y = 0.05;
    this.character.root.add(this.footRing);

    /** Positions of other living players ({x, z}), refreshed by main each frame. */
    this.others = [];
    this.onFall = null;
    this.onJump = null;
    this.onLand = null;
    this.airborne = false;
    this.vy = 0;
    this.onDeath = null;
    this.onHurt = null;
    this.applyCamera(0);
  }

  /** Move the respawn slot (multiplayer spreads players over the map). */
  setSpawn(x, z, yaw = this.spawn.yaw) {
    this.spawn.pos.set(x, 0, z);
    this.spawn.yaw = yaw;
  }

  /** Nearest point outside every hole, searching outward from here. */
  _safeSpot() {
    const w = this.world;
    for (let r = 1; r <= 14; r += 1) {
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * Math.PI * 2;
        const x = this.pos.x + Math.cos(a) * r;
        const z = this.pos.z + Math.sin(a) * r;
        if (w.inKillHole(x, z)) continue;
        if (w.isOpenGround && !w.isOpenGround(x, z, 0.3)) continue;
        return { x, z };
      }
    }
    return { x: this.spawn.pos.x, z: this.spawn.pos.z };
  }

  get locked() {
    return this.controls.state.locked;
  }

  reset() {
    this.pos.copy(this.spawn.pos);
    this.yaw = this.spawn.yaw;
    this.pitch = this.spawn.pitch;
    this.facing = this.yaw;
    this.vel.set(0, 0, 0);
    this.bob = 0;
    this.energy = 1;
    this.lives = this.maxLives;
    this.exhausted = false;
    this.alive = true;
    this.invuln = 0;
    this._fallV = 0;
    this.airborne = false;
    this.vy = 0;
    this.shake = 0;
    this.hitFlash = 0;
    this._camReady = false;
    this.character.root.visible = true;
    this.character.resetScale?.();
    this.pos.y = this.world.heightAt(this.pos.x, this.pos.z);
    this.character.update(this.pos, this.facing, 0, false, 0.016);
    this.applyCamera(0);
  }

  /**
   * Lethal contact: spend a life. Brief invuln + knock if lives remain;
   * at 0 lives → game over (same death overlay as before).
   */
  takeHit(reason = 'dead', opts = {}) {
    if (!this.alive || this.invuln > 0) return false;
    this.lives = Math.max(0, this.lives - 1);
    this.hitFlash = 1;
    this.addShake(opts.shake ?? 0.85);
    this.invuln = opts.invuln ?? 1.75;
    this.character.playHit?.();

    // Knock away from hazard or opposite travel
    const kx = opts.kx ?? (-Math.sign(this.vel.x || 1) * 4.5);
    const kz = opts.kz ?? (-Math.sign(this.vel.z || 1) * 4.5);
    this.vel.x += kx;
    this.vel.z += kz;

    if (opts.rescue) {
      this.pos.x = opts.rescue.x;
      this.pos.z = opts.rescue.z;
      this.pos.y = this.world.heightAt(this.pos.x, this.pos.z);
    }

    if (this.lives <= 0) {
      this.kill(reason);
      return true;
    }
    this.onHurt?.(reason, this.lives);
    return false;
  }

  kill(reason = 'dead') {
    if (!this.alive) return;
    this.alive = false;
    this.lives = 0;
    this.vel.set(0, 0, 0);
    this.hitFlash = 1;
    this.addShake(0.9);
    this.onDeath?.(reason);
  }

  addShake(amount) {
    this.shake = Math.min(1.6, this.shake + amount);
  }

  /** Other living players are solid: circle-vs-circle push-out. */
  _resolveOthers() {
    const min = 0.9; // two shoulder-width bodies
    for (const o of this.others) {
      const dx = this.pos.x - o.x;
      const dz = this.pos.z - o.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      const nx = d > 1e-4 ? dx / d : 1;
      const nz = d > 1e-4 ? dz / d : 0;
      this.pos.x += nx * (min - d);
      this.pos.z += nz * (min - d);
    }
  }

  _resolve(colliders, feetY) {
    const p = this.pos;
    const r = RADIUS;
    for (const c of colliders) {
      if (c.top !== undefined && c.top <= feetY + STEP) continue;
      if (c.bottom !== undefined && c.bottom > feetY + 1.9) continue;
      const x0 = c.x0 - r, x1 = c.x1 + r;
      const z0 = c.z0 - r, z1 = c.z1 + r;
      if (p.x <= x0 || p.x >= x1 || p.z <= z0 || p.z >= z1) continue;
      const dxL = p.x - x0, dxR = x1 - p.x;
      const dzL = p.z - z0, dzR = z1 - p.z;
      const m = Math.min(dxL, dxR, dzL, dzR);
      if (m === dxL) p.x = x0;
      else if (m === dxR) p.x = x1;
      else if (m === dzL) p.z = z0;
      else p.z = z1;
    }
  }

  update(dt) {
    this.invuln = Math.max(0, this.invuln - dt);
    // red screen flash lingers ~2.5 s after a hit / fall
    this.hitFlash = Math.max(0, this.hitFlash - dt * 0.4);

    if (!this.alive || !this.playing) {
      this.character.update(this.pos, this.facing, 0, false, dt);
      this.character.resetScale?.();
      this.applyCamera(0);
      return;
    }

    // Blink while invulnerable
    if (this.invuln > 0) {
      this.character.root.visible = Math.sin(performance.now() * 0.028) > 0;
      this.character.flashHurt?.(this.hitFlash);
    } else {
      this.character.root.visible = true;
      this.character.resetScale?.();
    }

    const look = this.controls.sample();
    this.yaw -= look.dx * this.sensitivity;
    this.pitch -= look.dy * this.sensitivity;
    this.pitch = clamp(this.pitch, 0.08, 0.85);

    const st = this.controls.state;
    let fwd = st.fwd;
    let side = st.side;
    let wantRun = st.sprint;

    const wishLen = Math.hypot(fwd, side);
    if (wishLen > 1) {
      fwd /= wishLen;
      side /= wishLen;
    }
    // Exhausted: drop to a walk and stay there until sprint is released and
    // the bar has meaningfully recovered (no run/walk stutter at empty).
    if (this.energy <= 0.01) this.exhausted = true;
    if (this.exhausted && !st.sprint && this.energy >= 0.25) this.exhausted = false;
    if (this.exhausted) wantRun = false;

    const speed = wantRun ? this.runSpeed : this.walkSpeed;

    // camera-relative movement (third-person)
    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this._wish
      .copy(this._forward).multiplyScalar(fwd)
      .addScaledVector(this._right, side);
    if (this._wish.lengthSq() > 1e-6) {
      this._wish.normalize().multiplyScalar(speed);
      this.facing = Math.atan2(-this._wish.x, -this._wish.z);
    }

    // Jump: real airtime — clears bins/cones and narrow cracks; costs a little energy
    const wantJump = this.controls.consumeJump?.();
    if (wantJump && !this.airborne && !this._fallV && this.energy >= 0.06) {
      this.airborne = true;
      this.vy = JUMP_V;
      this.energy -= 0.06;
      this.onJump?.();
    }

    const accel = this.airborne ? 3 : (this._wish.lengthSq() > 1e-6 ? 13 : 16);
    const a = 1 - Math.exp(-accel * dt);
    this.vel.x += (this._wish.x - this.vel.x) * a;
    this.vel.z += (this._wish.z - this.vel.z) * a;

    const feetY = this.world.heightAt(this.pos.x, this.pos.z);
    // Once falling into a shaft there's no walking back out
    const falling = this._fallV > 0 && this.world.inKillHole(this.pos.x, this.pos.z);
    if (!falling) this._fallV = 0;
    const stepX = falling ? 0 : this.vel.x * dt;
    const stepZ = falling ? 0 : this.vel.z * dt;
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(stepX), Math.abs(stepZ)) / 0.18));
    const feetNow = this.airborne ? Math.max(feetY, this.pos.y) : feetY;
    for (let i = 0; i < n; i++) {
      this.pos.x += stepX / n;
      this._resolve(this.world.colliders, feetNow);
      this.pos.z += stepZ / n;
      this._resolve(this.world.colliders, feetNow);
      this._resolveOthers();
    }

    if (this.airborne) {
      this.vy -= JUMP_G * dt;
      this.pos.y += this.vy * dt;
      const ground = this.world.surfaceAt ? this.world.surfaceAt(this.pos.x, this.pos.z) : 0;
      if (this.vy < 0 && this.pos.y <= ground) {
        this.pos.y = ground;
        this.airborne = false;
        this.vy = 0;
        this.onLand?.();
      }
    }

    const b = this.world.bounds;
    this.pos.x = clamp(this.pos.x, b.x0, b.x1);
    this.pos.z = clamp(this.pos.z, b.z0, b.z1);

    if (!this.airborne && this.world.inKillHole(this.pos.x, this.pos.z)) {
      // Gravity fall so the drop into the shaft actually reads on camera
      if (!this._fallV) this.onFall?.();
      this._fallV = (this._fallV || 1.5) + 22 * dt;
      this.pos.y -= this._fallV * dt;
      this.vel.multiplyScalar(Math.exp(-6 * dt));
      this.character.update(this.pos, this.facing, 0, false, dt);
      if (this.pos.y < -3.2) {
        this._fallV = 0;
        // Rescue to the nearest safe rim point if lives remain
        const hole = this.world.holeAt?.(this.pos.x, this.pos.z)
          || this.world.holes.find((h) => h.contains(this.pos.x, this.pos.z));
        const rescue = hole?.rescuePoint?.(this.pos.x, this.pos.z) || null;
        this.takeHit('fell', {
          shake: 1.0,
          invuln: 2.0,
          rescue: rescue || this._safeSpot(),
          kx: 0,
          kz: 0,
        });
      }
      this.applyCamera(0);
      return;
    }

    if (!this.airborne) {
      const targetY = this.world.heightAt(this.pos.x, this.pos.z, this.pos.y);
      this.pos.y += (targetY - this.pos.y) * (1 - Math.exp(-18 * dt));
    }

    const moving = Math.hypot(this.vel.x, this.vel.z);
    // Energy: sprint drains; walk and stand both recharge
    if (wantRun && moving > 0.35) {
      this.energy = Math.max(0, this.energy - this.drainRun * dt);
    } else {
      this.energy = Math.min(this.maxEnergy, this.energy + this.regenWalk * dt);
    }

    this.bob += dt * moving * (wantRun ? 8.2 : 6.4);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    this.footRing.material.opacity = 0.35 + Math.min(moving / this.runSpeed, 1) * 0.35;

    this.character.update(this.pos, this.facing, moving, wantRun, dt, this.airborne);
    this.applyCamera(moving);
  }

  /** Pull `cam` toward `from` so the segment between them clears every tall collider. */
  _clipCamera(from, cam) {
    const dx = cam.x - from.x;
    const dy = cam.y - from.y;
    const dz = cam.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.01) return;
    const pad = 0.3;
    const bx0 = Math.min(from.x, cam.x) - pad;
    const bx1 = Math.max(from.x, cam.x) + pad;
    const bz0 = Math.min(from.z, cam.z) - pad;
    const bz1 = Math.max(from.z, cam.z) + pad;
    let tMin = 1;
    for (const c of this.world.colliders) {
      if ((c.top ?? 99) < 2.0) continue; // low walls / objects / cars: look over them
      if (c.x1 < bx0 || c.x0 > bx1 || c.z1 < bz0 || c.z0 > bz1) continue;
      let t0 = 0;
      let t1 = tMin;
      const slab = (o, d, lo, hi) => {
        if (Math.abs(d) < 1e-6) return o >= lo && o <= hi;
        let a = (lo - o) / d;
        let b = (hi - o) / d;
        if (a > b) { const tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        return t0 <= t1;
      };
      if (!slab(from.x, dx, c.x0 - pad, c.x1 + pad)) continue;
      if (!slab(from.z, dz, c.z0 - pad, c.z1 + pad)) continue;
      if (!slab(from.y, dy, c.bottom ?? -1, (c.top ?? 99) + pad)) continue;
      if (t0 > 0 && t0 < tMin) tMin = t0;
    }
    if (tMin < 1) {
      const k = Math.max(0.12, tMin - 0.05 / len);
      cam.set(from.x + dx * k, from.y + dy * k, from.z + dz * k);
    }
  }

  applyCamera(moving) {
    const pitch = this.pitch;
    const dist = CAM_DIST;
    const ox = Math.sin(this.yaw) * Math.cos(pitch) * dist;
    const oy = Math.sin(pitch) * dist + CAM_HEIGHT * 0.35;
    const oz = Math.cos(this.yaw) * Math.cos(pitch) * dist;

    this._camPos.set(this.pos.x + ox, this.pos.y + oy + CAM_HEIGHT * 0.55, this.pos.z + oz);
    this._lookAt.set(this.pos.x, this.pos.y + CAM_LOOK, this.pos.z);

    if (!this._camReady) {
      this._smoothCam.copy(this._camPos);
      this._camReady = true;
    } else {
      const lag = 1 - Math.exp(-10 * Math.min(moving > 0.2 ? 0.05 : 0.08, 0.08) * 60);
      // frame-rate independent-ish smooth — use fixed blend from dt via moving path
      this._smoothCam.lerp(this._camPos, 0.18);
    }
    // Narrow streets: never let the chase camera sit inside / behind a house
    this._clipCamera(this._lookAt, this._smoothCam);

    let sx = 0, sy = 0, sz = 0;
    if (this.shake > 0.01) {
      const s = this.shake;
      const t = this.bob * 2.1 + performance.now() * 0.02;
      // punchy multi-frequency shake (readable quake juice)
      sx = Math.sin(t * 37) * s * 0.11 + Math.sin(t * 11) * s * 0.05;
      sy = Math.cos(t * 29) * s * 0.09;
      sz = Math.sin(t * 19) * s * 0.08;
    }

    this.camera.position.set(
      this._smoothCam.x + sx,
      this._smoothCam.y + sy,
      this._smoothCam.z + sz
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this._lookAt.x + sx * 0.3, this._lookAt.y + sy * 0.2, this._lookAt.z + sz * 0.3);
  }
}
