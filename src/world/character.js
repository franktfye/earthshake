import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { box, cyl, shadowify } from '../core/util.js';
import { hullOutline } from '../core/outline.js';

/**
 * Stylized third-person human — procedural boxes/capsules, toon + hull outline.
 * Clearer silhouette: longer legs, defined torso, readable head, walk/run cycle.
 * Authored facing -Z.
 */
export function createCharacter() {
  const skin = cel({ color: 0xf2d4bc, bands: 3, tint: 0x7a6080 });
  const hair = cel({ color: 0x2e2a3a, bands: 2, tint: 0x4a4060 });
  const shirt = cel({ color: 0x3f74b4, bands: 3, tint: 0x4a5a90 });
  const shirtDark = cel({ color: 0x356498, bands: 3, tint: 0x4a5a90 });
  const pants = cel({ color: 0x454358, bands: 3, tint: 0x4a4568 });
  const shoes = cel({ color: 0x262232, bands: 2, tint: 0x3a3550 });
  const accent = cel({ color: PAL.orange, bands: 3, tint: 0x8f7050 });

  const root = new THREE.Group();
  root.name = 'playerCharacter';

  const hips = new THREE.Group();
  hips.name = 'hips';
  root.add(hips);

  // Pelvis / torso stack — slightly taller silhouette
  hips.add(box(0.38, 0.18, 0.24, pants, 0, 0.92, 0));
  const torso = box(0.44, 0.52, 0.3, shirt, 0, 1.28, 0);
  hips.add(torso);
  hips.add(box(0.46, 0.1, 0.32, accent, 0, 1.5, 0)); // collar band
  hips.add(box(0.4, 0.08, 0.28, shirtDark, 0, 1.08, 0)); // waist tuck

  // Neck + head
  hips.add(cyl(0.07, 0.08, 0.1, 8, skin, 0, 1.6, 0));
  const head = cyl(0.17, 0.18, 0.3, 12, skin, 0, 1.82, 0);
  hips.add(head);
  hips.add(cyl(0.19, 0.17, 0.18, 12, hair, 0, 1.98, -0.02));
  hips.add(box(0.22, 0.09, 0.14, hair, 0, 2.08, -0.02));
  // Side hair volume for silhouette
  hips.add(box(0.08, 0.16, 0.14, hair, -0.16, 1.9, 0.02));
  hips.add(box(0.08, 0.16, 0.14, hair, 0.16, 1.9, 0.02));

  const eyeMat = flat({ color: 0x221c30 });
  const eyeWhite = flat({ color: 0xf6f0e8 });
  hips.add(box(0.06, 0.045, 0.02, eyeWhite, -0.065, 1.84, -0.165));
  hips.add(box(0.06, 0.045, 0.02, eyeWhite, 0.065, 1.84, -0.165));
  hips.add(box(0.035, 0.035, 0.02, eyeMat, -0.065, 1.84, -0.175));
  hips.add(box(0.035, 0.035, 0.02, eyeMat, 0.065, 1.84, -0.175));

  // Arms — upper + lower, hinged at shoulder
  const armL = new THREE.Group();
  armL.position.set(-0.3, 1.42, 0);
  const armLUpper = box(0.11, 0.28, 0.12, shirt, 0, -0.12, 0);
  armL.add(armLUpper);
  const armLFore = new THREE.Group();
  armLFore.position.set(0, -0.28, 0);
  armLFore.add(box(0.1, 0.26, 0.1, shirt, 0, -0.1, 0));
  armLFore.add(box(0.09, 0.1, 0.09, skin, 0, -0.28, 0));
  armL.add(armLFore);
  hips.add(armL);

  const armR = new THREE.Group();
  armR.position.set(0.3, 1.42, 0);
  armR.add(box(0.11, 0.28, 0.12, shirt, 0, -0.12, 0));
  const armRFore = new THREE.Group();
  armRFore.position.set(0, -0.28, 0);
  armRFore.add(box(0.1, 0.26, 0.1, shirt, 0, -0.1, 0));
  armRFore.add(box(0.09, 0.1, 0.09, skin, 0, -0.28, 0));
  armR.add(armRFore);
  hips.add(armR);

  // Legs — thigh + shin groups for a readable walk cycle
  const legL = new THREE.Group();
  legL.position.set(-0.12, 0.9, 0);
  const thighL = box(0.15, 0.32, 0.17, pants, 0, -0.14, 0);
  legL.add(thighL);
  const shinL = new THREE.Group();
  shinL.position.set(0, -0.32, 0);
  shinL.add(box(0.14, 0.3, 0.16, pants, 0, -0.12, 0));
  shinL.add(box(0.16, 0.1, 0.26, shoes, 0, -0.32, -0.04));
  legL.add(shinL);
  hips.add(legL);

  const legR = new THREE.Group();
  legR.position.set(0.12, 0.9, 0);
  legR.add(box(0.15, 0.32, 0.17, pants, 0, -0.14, 0));
  const shinR = new THREE.Group();
  shinR.position.set(0, -0.32, 0);
  shinR.add(box(0.14, 0.3, 0.16, pants, 0, -0.12, 0));
  shinR.add(box(0.16, 0.1, 0.26, shoes, 0, -0.32, -0.04));
  legR.add(shinR);
  hips.add(legR);

  shadowify(root);
  const toOutline = [];
  root.traverse((o) => {
    if (o.isMesh && !o.userData.isOutline) toOutline.push(o);
  });
  for (const m of toOutline) {
    const shell = hullOutline(m, { thickness: 0.0038, color: PAL.ink });
    if (shell) shell.userData.isOutline = true;
  }

  const api = {
    root,
    hips,
    armL,
    armR,
    armLFore,
    armRFore,
    legL,
    legR,
    shinL,
    shinR,
    facing: 0,
    _walkPhase: 0,
    setPose(moving, run, dt) {
      if (moving > 0.35) {
        const rate = run ? 13.5 : 9.2;
        this._walkPhase += dt * rate;
        const swing = Math.sin(this._walkPhase) * (run ? 0.72 : 0.48);
        const knee = Math.max(0, -Math.sin(this._walkPhase)) * (run ? 0.55 : 0.35);
        const kneeR = Math.max(0, Math.sin(this._walkPhase)) * (run ? 0.55 : 0.35);

        this.legL.rotation.x = swing;
        this.legR.rotation.x = -swing;
        this.shinL.rotation.x = knee;
        this.shinR.rotation.x = kneeR;

        this.armL.rotation.x = -swing * 0.85;
        this.armR.rotation.x = swing * 0.85;
        this.armLFore.rotation.x = -0.15 - Math.abs(swing) * 0.2;
        this.armRFore.rotation.x = -0.15 - Math.abs(swing) * 0.2;

        // Hip bob + slight lean into run
        const bob = Math.abs(Math.sin(this._walkPhase * 2)) * (run ? 0.04 : 0.025);
        this.hips.position.y = bob;
        this.hips.rotation.z = Math.sin(this._walkPhase) * 0.04;
        this.hips.rotation.x = run ? -0.08 : -0.02;
      } else {
        this.legL.rotation.x *= 0.75;
        this.legR.rotation.x *= 0.75;
        this.shinL.rotation.x *= 0.75;
        this.shinR.rotation.x *= 0.75;
        this.armL.rotation.x *= 0.75;
        this.armR.rotation.x *= 0.75;
        this.armLFore.rotation.x *= 0.8;
        this.armRFore.rotation.x *= 0.8;
        this.hips.position.y *= 0.8;
        this.hips.rotation.z *= 0.8;
        this.hips.rotation.x *= 0.8;
      }
    },
    update(pos, facingYaw, moving, run, dt) {
      this.root.position.set(pos.x, pos.y, pos.z);
      this.facing = facingYaw;
      this.root.rotation.y = facingYaw;
      this.setPose(moving, run, dt);
    },
    /** Brief hurt squash / flash cue */
    flashHurt(t) {
      const s = 1 + Math.sin(t * 40) * 0.04 * Math.min(1, t * 3);
      this.root.scale.set(s, 1 / s, s);
    },
    resetScale() {
      this.root.scale.set(1, 1, 1);
    },
  };
  return api;
}
