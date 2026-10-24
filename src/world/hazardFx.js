import * as THREE from 'three';

/**
 * Fire + explosion visuals and warning signs.
 *
 * Every flame and smoke particle of every fire lives in two THREE.Points
 * systems (one draw call each) and is animated entirely in the vertex shader
 * from a per-particle seed and the shared hazard clock, so dozens of
 * never-ending fires cost almost nothing on the CPU.
 */

const FLAMES_PER_FIRE = 42;
const SMOKE_PER_FIRE = 10;

const FIRE_VERT = /* glsl */ `
  attribute vec4 aBase;   // xyz centre-offset position, w = ignite time
  attribute vec4 aSeed;   // phase, speed, size, radius scale
  uniform float uTime;
  uniform float uScale;
  uniform float uRise;
  varying float vLife;
  varying float vAlive;
  void main() {
    vAlive = step(aBase.w, uTime);
    float age = max(0.0, uTime - aBase.w);
    // fires creep outward a little over the first few minutes
    float grow = 1.0 + min(0.45, age / 260.0);
    float life = fract(uTime * aSeed.y + aSeed.x);
    vLife = life;
    vec3 p = vec3(aBase.x * grow, aBase.y, aBase.z * grow);
    float sway = sin(uTime * 3.1 + aSeed.x * 40.0) * 0.18 * life;
    p.x += sway;
    p.z += cos(uTime * 2.7 + aSeed.x * 31.0) * 0.18 * life;
    p.y += life * uRise * (0.7 + aSeed.w * 0.6);
    // flames pull toward the column as they rise
    p.xz *= mix(1.0, 0.55, life);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    float size = aSeed.z * mix(1.0, 0.35, life) * vAlive;
    gl_PointSize = size * uScale / max(0.5, -mv.z);
  }
`;

const FLAME_FRAG = /* glsl */ `
  varying float vLife;
  varying float vAlive;
  void main() {
    if (vAlive < 0.5) discard;
    // teardrop: round bottom, pointed top (gl_PointCoord.y grows downward)
    vec2 c = gl_PointCoord - vec2(0.5, 0.62);
    c.x *= 1.0 + max(0.0, -c.y) * 2.2;
    float d = length(c * vec2(1.25, 0.95));
    if (d > 0.42) discard;
    float soft = smoothstep(0.42, 0.12, d);
    vec3 hot = vec3(1.0, 0.86, 0.32);
    vec3 mid = vec3(1.0, 0.42, 0.06);
    vec3 cool = vec3(0.78, 0.1, 0.04);
    vec3 col = mix(hot, mid, smoothstep(0.0, 0.4, vLife));
    col = mix(col, cool, smoothstep(0.4, 1.0, vLife));
    // white-hot core near the base
    col = mix(col, vec3(1.0, 0.97, 0.8), smoothstep(0.18, 0.0, d) * (1.0 - vLife));
    float a = soft * pow(1.0 - vLife, 0.8) * 0.95;
    gl_FragColor = vec4(col, a);
  }
`;

const SMOKE_FRAG = /* glsl */ `
  varying float vLife;
  varying float vAlive;
  void main() {
    if (vAlive < 0.5) discard;
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float soft = smoothstep(0.5, 0.05, d);
    float a = soft * smoothstep(0.0, 0.18, vLife) * (1.0 - vLife) * 0.55;
    gl_FragColor = vec4(mix(vec3(0.16, 0.13, 0.14), vec3(0.42, 0.38, 0.4), vLife), a);
  }
`;

function makePointsSystem(capacity, frag, blending, rise, scale) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(capacity * 3);
  const base = new Float32Array(capacity * 4);
  const seed = new Float32Array(capacity * 4);
  for (let i = 0; i < capacity; i++) base[i * 4 + 3] = 1e9; // not ignited
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aBase', new THREE.BufferAttribute(base, 4));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: scale }, uRise: { value: rise } },
    vertexShader: FIRE_VERT,
    fragmentShader: frag,
    transparent: true,
    depthWrite: false,
    blending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  return { points, geo, base, seed, used: 0, capacity, mat };
}

let flameTex = null;
const signTex = {};

/** Canvas warning sign: yellow triangle + black border + icon. */
function warnSignTexture(kind) {
  if (signTex[kind]) return signTex[kind];
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.lineJoin = 'round';
  g.beginPath();
  g.moveTo(64, 8); g.lineTo(122, 116); g.lineTo(6, 116); g.closePath();
  g.fillStyle = '#ffcc1f'; g.fill();
  g.lineWidth = 9; g.strokeStyle = '#1d1a1f'; g.stroke();
  g.fillStyle = '#1d1a1f';
  if (kind === 'fire') {
    // flame icon
    g.beginPath();
    g.moveTo(64, 46);
    g.bezierCurveTo(80, 62, 88, 76, 82, 92);
    g.bezierCurveTo(78, 104, 50, 106, 45, 92);
    g.bezierCurveTo(40, 80, 52, 74, 54, 64);
    g.bezierCurveTo(60, 72, 60, 78, 64, 80);
    g.bezierCurveTo(66, 70, 62, 58, 64, 46);
    g.fill();
    g.fillStyle = '#ffcc1f';
    g.beginPath();
    g.ellipse(64, 94, 7, 9, 0, 0, Math.PI * 2);
    g.fill();
  } else {
    // explosion burst icon
    g.beginPath();
    const cx = 64, cy = 82;
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 ? 11 : 27;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r * 0.92;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.closePath();
    g.fill();
    g.fillStyle = '#ffcc1f';
    g.font = 'bold 22px sans-serif';
    g.textAlign = 'center';
    g.fillText('!', cx, cy + 8);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  signTex[kind] = t;
  return t;
}

function fireballTexture() {
  if (flameTex) return flameTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,248,210,1)');
  grd.addColorStop(0.35, 'rgba(255,170,60,0.95)');
  grd.addColorStop(0.7, 'rgba(220,70,20,0.55)');
  grd.addColorStop(1, 'rgba(120,20,10,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  flameTex = new THREE.CanvasTexture(c);
  flameTex.colorSpace = THREE.SRGBColorSpace;
  return flameTex;
}

export function createHazardFx(world) {
  const MAX_FIRES = 72;
  const flames = makePointsSystem(MAX_FIRES * FLAMES_PER_FIRE, FLAME_FRAG, THREE.NormalBlending, 3.0, 1250);
  const smoke = makePointsSystem(MAX_FIRES * SMOKE_PER_FIRE, SMOKE_FRAG, THREE.NormalBlending, 7.5, 1500);
  world.add(flames.points);
  world.add(smoke.points);

  const scorchMat = new THREE.MeshBasicMaterial({
    color: 0x1c1416, transparent: true, opacity: 0.7, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
  });
  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xff7a2a, transparent: true, opacity: 0.35, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const fires = [];
  const transients = [];

  function addParticles(sys, n, x, y, z, r, igniteAt, seedFn) {
    if (sys.used + n > sys.capacity) return;
    const i0 = sys.used;
    for (let i = 0; i < n; i++) {
      const k = i0 + i;
      const a = seedFn.r() * Math.PI * 2;
      const d = Math.sqrt(seedFn.r()) * r;
      sys.base.set([x + Math.cos(a) * d, y, z + Math.sin(a) * d, igniteAt], k * 4);
      sys.seed.set([seedFn.r(), seedFn.speed(), seedFn.size(), seedFn.r()], k * 4);
    }
    sys.used += n;
    sys.geo.attributes.aBase.needsUpdate = true;
    sys.geo.attributes.aSeed.needsUpdate = true;
    sys.geo.setDrawRange(0, sys.used);
    // aBase.xyz are world positions; keep the Points object at the origin
  }

  /**
   * Permanent fire at (x, z), radius r, igniting at hazard-clock time igniteAt.
   * `rand` is a per-fire RNG (cosmetic only).
   */
  function addFire(x, z, r, igniteAt, rand, groundY = 0.1) {
    if (fires.length >= MAX_FIRES) return null;
    addParticles(flames, FLAMES_PER_FIRE, x, groundY, z, r * 0.62, igniteAt, {
      r: () => rand.next(),
      speed: () => rand.range(0.9, 1.6),
      size: () => rand.range(1.0, 1.9) * (0.8 + r * 0.3),
    });
    addParticles(smoke, SMOKE_PER_FIRE, x, groundY + 1.2, z, r * 0.5, igniteAt, {
      r: () => rand.next(),
      speed: () => rand.range(0.12, 0.22),
      size: () => rand.range(1.8, 3.0),
    });
    const scorch = new THREE.Mesh(new THREE.CircleGeometry(r * 1.15, 28), scorchMat);
    scorch.rotation.x = -Math.PI / 2;
    scorch.position.set(x, groundY + 0.015, z);
    scorch.visible = false;
    const glow = new THREE.Mesh(new THREE.CircleGeometry(r * 1.35, 28), glowMat.clone());
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(x, groundY + 0.02, z);
    glow.visible = false;
    world.add(scorch);
    world.add(glow);
    const f = { x, z, r, igniteAt, scorch, glow, phase: rand.range(0, 6) };
    fires.push(f);
    return f;
  }

  /** Floating ⚠ sign (fire | blast) that bobs over a hazard spot. */
  function makeSign(kind, x, z, y = 2.4) {
    const mat = new THREE.SpriteMaterial({
      map: warnSignTexture(kind), depthTest: false, depthWrite: false, fog: false, transparent: true,
    });
    const s = new THREE.Sprite(mat);
    s.scale.set(1.25, 1.25, 1);
    s.position.set(x, y, z);
    s.renderOrder = 12;
    s.userData.baseY = y;
    world.add(s);
    return s;
  }

  function updateSign(s, t) {
    s.position.y = s.userData.baseY + Math.sin(t * 5) * 0.12;
    const blink = 0.65 + 0.35 * Math.sin(t * 14);
    s.material.opacity = blink;
  }

  function removeSign(s) {
    if (!s) return;
    world.root.remove(s);
    s.material.dispose();
  }

  /** Expanding fireball + shock ring for an explosion. */
  function fireball(x, z, r, y = 0.6) {
    // normal blending: additive washed out to white over bright walls
    const mat = new THREE.SpriteMaterial({
      map: fireballTexture(), depthWrite: false, transparent: true, fog: false,
    });
    const s = new THREE.Sprite(mat);
    s.position.set(x, y + 0.8, z);
    s.scale.set(0.5, 0.5, 1);
    world.add(s);
    transients.push({ obj: s, life: 0.55, max: 0.55, r });
  }

  function update(t, dt) {
    flames.mat.uniforms.uTime.value = t;
    smoke.mat.uniforms.uTime.value = t;
    for (const f of fires) {
      const lit = t >= f.igniteAt;
      f.scorch.visible = lit;
      f.glow.visible = lit;
      if (lit) {
        f.glow.material.opacity = 0.22 + 0.14 * Math.sin(t * 11 + f.phase) + 0.06 * Math.sin(t * 23 + f.phase * 2);
        const grow = 1 + Math.min(0.45, (t - f.igniteAt) / 260);
        f.glow.scale.set(grow, grow, 1);
        f.scorch.scale.set(grow, grow, 1);
      }
    }
    for (let i = transients.length - 1; i >= 0; i--) {
      const tr = transients[i];
      tr.life -= dt;
      const u = 1 - tr.life / tr.max;
      const k = 0.8 + Math.sqrt(u) * tr.r * 2.6;
      tr.obj.scale.set(k, k, 1);
      tr.obj.material.opacity = Math.max(0, 1 - u * u);
      if (tr.life <= 0) {
        world.root.remove(tr.obj);
        tr.obj.material.dispose();
        transients.splice(i, 1);
      }
    }
  }

  function reset() {
    for (const f of fires) {
      world.root.remove(f.scorch);
      world.root.remove(f.glow);
      f.scorch.geometry.dispose();
      f.glow.geometry.dispose();
      f.glow.material.dispose();
    }
    fires.length = 0;
    for (const sys of [flames, smoke]) {
      sys.used = 0;
      sys.geo.setDrawRange(0, 0);
    }
  }

  return { addFire, makeSign, updateSign, removeSign, fireball, update, reset, fires };
}
