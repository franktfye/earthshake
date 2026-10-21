import * as THREE from 'three';
import { Scene, Character, Animation } from '@viggle/splat-engine';

/**
 * PlayCanvas Gaussian-splat layer for Pinoc .vsplat characters.
 * Renders into a transparent overlay canvas; camera is synced from Three.js
 * each frame so the avatar lines up with the existing third-person view.
 *
 * Occlusion vs Three world meshes is approximate (separate GL contexts) —
 * fine for open-street play; characters paint above the Three canvas.
 */

const BASE = (import.meta.env.BASE_URL || './').replace(/\/?$/, '/');

const ASSETS = {
  high: `${BASE}character/aftershock-hero.high.vsplat`,
  performance: `${BASE}character/aftershock-hero.performance.vsplat`,
  idle: `${BASE}character/motions/Standing_Idle.splat-skeleton.glb`,
  walk: `${BASE}character/motions/Walking.splat-skeleton.glb`,
  run: `${BASE}character/motions/Running.splat-skeleton.glb`,
  hit: `${BASE}character/motions/Hit_Reaction_Front.splat-skeleton.glb`,
  // PINOC library clips "Jump" / "Run Jump" (~2.1 s / 1.9 s incl. wind-up + landing)
  jump: `${BASE}character/motions/Jumping.splat-skeleton.glb`,
  runJump: `${BASE}character/motions/Run_Jump.splat-skeleton.glb`,
  // Aoi (female) — built with the same Pinoc pipeline from aftershock-heroine-sheet.jpg
  fHigh: `${BASE}character/aftershock-heroine.high.vsplat`,
  fPerformance: `${BASE}character/aftershock-heroine.performance.vsplat`,
};

/** HEAD probe so optional assets (heroine, jump clip) degrade gracefully. */
async function exists(url) {
  try {
    const r = await fetch(url, { method: 'HEAD' });
    return r.ok && !/text\/html/.test(r.headers.get('content-type') || '');
  } catch {
    return false;
  }
}

/** Mixamo/Pinoc forward is +Z; Aftershock facing 0 looks −Z. */
const YAW_OFFSET_DEG = 180;
/** Uniform scale so feet/capsule roughly match the old ~2 m stylized human. */
const AVATAR_SCALE = 1.0;

let _layer = null;

function isMobile() {
  return window.matchMedia?.('(pointer: coarse)')?.matches || window.innerWidth < 720;
}

/**
 * @param {HTMLCanvasElement} canvas overlay canvas (transparent)
 * @returns {Promise<{
 *   ready: boolean,
 *   scene: import('@viggle/splat-engine').Scene,
 *   createAvatar: (opts?: { lod?: 'high'|'performance' }) => Promise<object>,
 *   syncCamera: (threeCamera: THREE.Camera) => void,
 *   resize: () => void,
 *   destroy: () => void,
 * }>}
 */
export async function initPinocLayer(canvas) {
  if (_layer) return _layer;

  canvas.style.background = 'transparent';

  const scene = await Scene.create(canvas, {
    fov: 48,
    near: 0.2,
    far: 400,
    bgColor: { r: 0, g: 0, b: 0, a: 0 },
    preserveDrawingBuffer: true,
    backend: 'webgl',
    maxPixelRatio: 1,
    antialias: false,
    gsplatCulling: true,
    ambientLight: 0.7,
    exposure: 1.05,
  });

  Character.prefetch(ASSETS.performance);
  Character.prefetch(ASSETS.high);

  const [hasJump, hasRunJump, hasFemale] = await Promise.all([
    exists(ASSETS.jump), exists(ASSETS.runJump), exists(ASSETS.fPerformance),
  ]);
  await Promise.all([
    Animation.loadGlb(scene, ASSETS.idle, 'idle'),
    Animation.loadGlb(scene, ASSETS.walk, 'walk'),
    Animation.loadGlb(scene, ASSETS.run, 'run'),
    Animation.loadGlb(scene, ASSETS.hit, 'hit'),
    hasJump ? Animation.loadGlb(scene, ASSETS.jump, 'jump') : null,
    hasRunJump ? Animation.loadGlb(scene, ASSETS.runJump, 'runjump') : null,
  ]);

  scene.start();

  const _euler = new THREE.Euler();

  function syncCamera(threeCamera) {
    if (!threeCamera || scene.destroyed) return;
    const cam = scene.cameraEntity;
    const p = threeCamera.position;
    cam.setPosition(p.x, p.y, p.z);
    _euler.setFromQuaternion(threeCamera.quaternion, 'YXZ');
    cam.setEulerAngles(
      THREE.MathUtils.radToDeg(_euler.x),
      THREE.MathUtils.radToDeg(_euler.y),
      THREE.MathUtils.radToDeg(_euler.z)
    );
    const pcCam = cam.camera;
    if (pcCam && threeCamera.isPerspectiveCamera) {
      pcCam.fov = threeCamera.fov;
      pcCam.nearClip = threeCamera.near;
      pcCam.farClip = threeCamera.far;
      pcCam.aspectRatio = threeCamera.aspect;
    }
  }

  async function createAvatar({ lod, gender = 'm' } = {}) {
    if (gender === 'f' && !hasFemale) throw new Error('heroine splat not available');
    const quality = lod || (isMobile() ? 'performance' : 'high');
    const url = gender === 'f'
      ? (quality === 'high' ? ASSETS.fHigh : ASSETS.fPerformance)
      : (quality === 'high' ? ASSETS.high : ASSETS.performance);
    const pc = await Character.load(scene, url, { name: `${gender === 'f' ? 'heroine' : 'hero'}_${quality}` });
    pc.setScale(AVATAR_SCALE, AVATAR_SCALE, AVATAR_SCALE);
    pc.playAnimation('idle', { loop: true, rootMotion: false });

    const root = new THREE.Group();
    root.name = 'pinocAvatar';
    root.userData.pinoc = true;

    let clip = 'idle';
    let hitLeft = 0;
    let visible = true;

    function applyVisibility() {
      const on = visible && root.visible;
      if (typeof pc.setActive === 'function') pc.setActive(on);
      else if (pc.splat?.entity) pc.splat.entity.enabled = on;
      if (!on) pc.setReveal?.(0);
      else pc.setReveal?.(1);
    }

    const api = {
      root,
      hips: root,
      facing: 0,
      ready: true,
      pinoc: true,
      _pc: pc,

      gender,

      update(pos, facingYaw, moving, run, dt, air = false) {
        root.position.set(pos.x, pos.y, pos.z);
        root.rotation.y = facingYaw;
        this.facing = facingYaw;

        pc.setPosition(pos.x, pos.y, pos.z);
        const yDeg = THREE.MathUtils.radToDeg(facingYaw) + YAW_OFFSET_DEG;
        pc.setRotation(0, yDeg, 0);
        applyVisibility();

        if (hitLeft > 0) {
          hitLeft -= dt;
          if (pc.isFinished || hitLeft <= 0) {
            hitLeft = 0;
            clip = ''; // force loco reselect
          } else {
            return;
          }
        }

        let next = 'idle';
        if (air && (hasJump || hasRunJump)) {
          next = (moving > 1.5 && hasRunJump) || !hasJump ? 'runjump' : 'jump';
        } else if (moving > 0.35) next = run ? 'run' : 'walk';
        if (next === 'jump' || next === 'runjump') {
          // keep whichever take-off we started with for the whole hop
          if (clip !== 'jump' && clip !== 'runjump') {
            pc.crossfadeTo(next, { duration: 0.06, loop: false, rootMotion: false });
            clip = next;
          }
          // squeeze the ~2 s clip (wind-up → air → landing) into ~0.9 s of hop
          pc.playbackSpeed = clip === 'runjump' ? 2.1 : 2.3;
          return;
        }
        if (next !== clip) {
          pc.crossfadeTo(next, { duration: 0.14, loop: true, rootMotion: false });
          clip = next;
        }

        if (next === 'walk') {
          pc.playbackSpeed = THREE.MathUtils.clamp(moving / 2.55, 0.75, 1.45);
        } else if (next === 'run') {
          pc.playbackSpeed = THREE.MathUtils.clamp(moving / 5.1, 0.8, 1.35);
        } else {
          pc.playbackSpeed = 1;
        }
      },

      playHit() {
        hitLeft = 0.85;
        clip = 'hit';
        pc.crossfadeTo('hit', { duration: 0.06, loop: false, rootMotion: false });
      },

      flashHurt(t) {
        const k = Math.min(1, Math.max(0, t));
        pc.setTint(0.15 + k * 0.55, { r: 1, g: 0.25, b: 0.2 });
        const s = 1 + Math.sin(t * 40) * 0.03 * Math.min(1, t * 3);
        pc.setScale(AVATAR_SCALE * s, AVATAR_SCALE / s, AVATAR_SCALE * s);
      },

      resetScale() {
        pc.setTint(0);
        pc.setScale(AVATAR_SCALE, AVATAR_SCALE, AVATAR_SCALE);
      },

      setVisible(v) {
        visible = !!v;
        root.visible = visible;
        applyVisibility();
      },

      destroy() {
        try { pc.destroy?.(); } catch { /* */ }
        if (root.parent) root.parent.remove(root);
      },
    };

    return api;
  }

  _layer = {
    ready: true,
    hasJump: hasJump || hasRunJump,
    hasFemale,
    scene,
    createAvatar,
    syncCamera,
    resize() {
      // Scene ResizeObserver handles canvas CSS size; nudge camera aspect
      const w = canvas.clientWidth || window.innerWidth;
      const h = canvas.clientHeight || window.innerHeight;
      const pcCam = scene.cameraEntity?.camera;
      if (pcCam && h > 0) pcCam.aspectRatio = w / h;
    },
    destroy() {
      try { scene.destroy(); } catch { /* */ }
      _layer = null;
    },
  };

  window.__aftershockPinoc = { ready: true, assets: ASSETS, hasJump, hasRunJump, hasFemale };
  return _layer;
}

export function getPinocLayer() {
  return _layer;
}
