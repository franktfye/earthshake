import * as THREE from 'three';
import { PAL } from '../core/palette.js';
import { cel, flat } from '../core/toon.js';
import { box, cyl, shadowify } from '../core/util.js';
import { hullOutline } from '../core/outline.js';

/**
 * Stylized third-person human — procedural boxes/capsules, toon + hull outline.
 * Authored facing -Z (same as camera forward when yaw = 0).
 */
export function createCharacter() {
  const skin = cel({ color: 0xf0d0b8, bands: 3, tint: 0x7a6080 });
  const hair = cel({ color: 0x3a3448, bands: 2, tint: 0x4a4060 });
  const shirt = cel({ color: 0x4a7ab8, bands: 3, tint: 0x4a5a90 });
  const pants = cel({ color: 0x4a4858, bands: 3, tint: 0x4a4568 });
  const shoes = cel({ color: 0x2e2a38, bands: 2, tint: 0x3a3550 });
  const accent = cel({ color: PAL.orange, bands: 3, tint: 0x8f7050 });

  const root = new THREE.Group();
  root.name = 'playerCharacter';

  const hips = new THREE.Group();
  hips.name = 'hips';
  root.add(hips);

  // torso
  const torso = box(0.42, 0.55, 0.28, shirt, 0, 1.15, 0);
  hips.add(torso);
  hips.add(box(0.44, 0.12, 0.3, accent, 0, 1.38, 0)); // collar / scarf band

  // head
  const head = cyl(0.16, 0.17, 0.28, 10, skin, 0, 1.62, 0);
  hips.add(head);
  const hairMesh = cyl(0.18, 0.16, 0.16, 10, hair, 0, 1.78, -0.02);
  hips.add(hairMesh);
  hips.add(box(0.2, 0.08, 0.12, hair, 0, 1.88, -0.02)); // bangs
  // eyes (flat)
  const eyeMat = flat({ color: 0x2a2438 });
  hips.add(box(0.05, 0.04, 0.02, eyeMat, -0.06, 1.64, -0.16));
  hips.add(box(0.05, 0.04, 0.02, eyeMat, 0.06, 1.64, -0.16));

  // arms
  const armL = new THREE.Group();
  armL.position.set(-0.28, 1.32, 0);
  armL.add(box(0.12, 0.42, 0.12, shirt, 0, -0.18, 0));
  armL.add(box(0.1, 0.14, 0.1, skin, 0, -0.42, 0));
  hips.add(armL);
  const armR = new THREE.Group();
  armR.position.set(0.28, 1.32, 0);
  armR.add(box(0.12, 0.42, 0.12, shirt, 0, -0.18, 0));
  armR.add(box(0.1, 0.14, 0.1, skin, 0, -0.42, 0));
  hips.add(armR);

  // legs
  const legL = new THREE.Group();
  legL.position.set(-0.12, 0.88, 0);
  legL.add(box(0.14, 0.48, 0.16, pants, 0, -0.22, 0));
  legL.add(box(0.15, 0.12, 0.24, shoes, 0, -0.5, -0.04));
  hips.add(legL);
  const legR = new THREE.Group();
  legR.position.set(0.12, 0.88, 0);
  legR.add(box(0.14, 0.48, 0.16, pants, 0, -0.22, 0));
  legR.add(box(0.15, 0.12, 0.24, shoes, 0, -0.5, -0.04));
  hips.add(legR);

  shadowify(root);
  // outline hero meshes (collect first — outlining during traverse recurses forever)
  const toOutline = [];
  root.traverse((o) => {
    if (o.isMesh && !o.userData.isOutline) toOutline.push(o);
  });
  for (const m of toOutline) {
    const shell = hullOutline(m, { thickness: 0.0036, color: PAL.ink });
    if (shell) shell.userData.isOutline = true;
  }

  const api = {
    root,
    armL,
    armR,
    legL,
    legR,
    facing: 0,
    _walkPhase: 0,
    setPose(moving, run, dt) {
      if (moving > 0.35) {
        this._walkPhase += dt * (run ? 11 : 8);
        const swing = Math.sin(this._walkPhase) * (run ? 0.55 : 0.4);
        this.legL.rotation.x = swing;
        this.legR.rotation.x = -swing;
        this.armL.rotation.x = -swing * 0.7;
        this.armR.rotation.x = swing * 0.7;
      } else {
        this.legL.rotation.x *= 0.8;
        this.legR.rotation.x *= 0.8;
        this.armL.rotation.x *= 0.8;
        this.armR.rotation.x *= 0.8;
      }
    },
    update(pos, facingYaw, moving, run, dt) {
      this.root.position.set(pos.x, pos.y, pos.z);
      this.facing = facingYaw;
      this.root.rotation.y = facingYaw;
      this.setPose(moving, run, dt);
    },
  };
  return api;
}
