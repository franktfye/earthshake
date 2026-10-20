import * as THREE from 'three';
import { PAL } from './palette.js';

const JP_FONT = `'Yu Gothic', 'Yu Gothic UI', 'Meiryo', 'MS Gothic', 'Hiragino Kaku Gothic ProN', sans-serif`;
const cache = new Map();

function make(w, h, draw, { srgb = true, aniso = 4 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = true;
  draw(c, w, h);
  const tex = new THREE.CanvasTexture(cv);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

function cached(key, fn) {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
}

const hex = (n) => '#' + n.toString(16).padStart(6, '0');

export const shopSign = (label = '青空商店') =>
  cached('shop:' + label, () =>
    make(512, 128, (c, w, h) => {
      c.fillStyle = '#e8e0d4';
      c.fillRect(0, 0, w, h);
      c.fillStyle = hex(PAL.orange);
      c.fillRect(0, h - 10, w, 10);
      c.fillRect(0, 0, w, 8);
      c.font = `bold 56px ${JP_FONT}`;
      c.fillStyle = '#3a3428';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(label, w * 0.5, h * 0.48);
    })
  );

export const crackNoise = () =>
  cached('crackNoise', () =>
    make(256, 256, (c, w, h) => {
      c.fillStyle = 'rgba(0,0,0,0)';
      c.clearRect(0, 0, w, h);
      c.strokeStyle = 'rgba(40,36,32,0.85)';
      c.lineWidth = 2;
      for (let i = 0; i < 18; i++) {
        c.beginPath();
        let x = Math.random() * w;
        let y = Math.random() * h;
        c.moveTo(x, y);
        for (let j = 0; j < 6; j++) {
          x += (Math.random() - 0.5) * 40;
          y += (Math.random() - 0.5) * 40;
          c.lineTo(x, y);
        }
        c.stroke();
      }
    }, { srgb: false })
  );

export const litWindowTex = () =>
  cached('litWin', () =>
    make(64, 64, (c, w, h) => {
      c.fillStyle = '#3a4550';
      c.fillRect(0, 0, w, h);
      c.fillStyle = '#c8a060';
      c.fillRect(8, 8, w - 16, h - 16);
      c.fillStyle = 'rgba(40,36,32,0.35)';
      c.fillRect(w * 0.45, 8, 3, h - 16);
    })
  );
