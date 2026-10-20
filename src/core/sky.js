import * as THREE from 'three';
import { PAL } from './palette.js';
import { flat } from './toon.js';

/** Gradient sky dome — ash / ochre haze. */
export function buildSky(scene, radius = 280) {
  const geo = new THREE.SphereGeometry(radius, 32, 16);
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 128;
  const c = canvas.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#' + PAL.skyTop.toString(16).padStart(6, '0'));
  g.addColorStop(0.45, '#' + PAL.skyMid.toString(16).padStart(6, '0'));
  g.addColorStop(1, '#' + PAL.skyHaze.toString(16).padStart(6, '0'));
  c.fillStyle = g;
  c.fillRect(0, 0, 4, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  scene.add(mesh);

  // soft distant hills as flat silhouettes
  const hillMat = flat({ color: PAL.hillFar, fog: true });
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const h = 4 + (i % 3) * 2.5;
    const hill = new THREE.Mesh(new THREE.BoxGeometry(28, h, 8), hillMat);
    hill.position.set(Math.cos(ang) * 90, h * 0.35, Math.sin(ang) * 90);
    hill.rotation.y = -ang;
    scene.add(hill);
  }

  return mesh;
}
