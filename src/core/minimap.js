import { MAP, ROADS, PLAZA, corridorHalf } from '../world/street.js';
import { pointAt } from '../world/fissureShape.js';

/**
 * Corner minimap: street grid, open fissures, survivors, and you.
 * Redrawn ~10 Hz on a small 2D canvas — cheap even on phones.
 */
export function createMinimap() {
  const canvas = document.createElement('canvas');
  canvas.className = 'minimap';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  let size = 0;
  let acc = 1;
  let visible = false;

  const base = document.createElement('canvas');

  function layout() {
    const short = Math.min(window.innerWidth, window.innerHeight);
    const s = short < 500 ? 104 : short < 720 ? 124 : 156;
    if (s === size) return;
    size = s;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [canvas, base]) {
      c.width = Math.round(s * dpr);
      c.height = Math.round(s * dpr);
    }
    canvas.style.width = `${s}px`;
    canvas.style.height = `${s}px`;
    drawBase(dpr);
  }

  const toPx = (v) => ((v + MAP.half) / (MAP.half * 2)) * base.width;

  function drawBase(dpr) {
    const b = base.getContext('2d');
    const W = base.width;
    b.clearRect(0, 0, W, W);
    b.fillStyle = 'rgba(70, 64, 92, 0.78)';
    b.fillRect(0, 0, W, W);
    // corridors (road + sidewalks)
    b.fillStyle = 'rgba(236, 230, 240, 0.9)';
    for (const r of ROADS) {
      const h = corridorHalf(r);
      if (r.axis === 'x') b.fillRect(0, toPx(r.c - h), W, toPx(r.c + h) - toPx(r.c - h));
      else b.fillRect(toPx(r.c - h), 0, toPx(r.c + h) - toPx(r.c - h), W);
    }
    b.fillRect(toPx(-PLAZA.half), toPx(-PLAZA.half), toPx(PLAZA.half) - toPx(-PLAZA.half), toPx(PLAZA.half) - toPx(-PLAZA.half));
    b.fillStyle = 'rgba(70, 64, 92, 0.9)';
    const m = toPx(1.3) - toPx(0);
    b.fillRect(toPx(0) - m, toPx(0) - m, m * 2, m * 2);
    b.strokeStyle = 'rgba(46, 42, 40, 0.6)';
    b.lineWidth = 1.5 * dpr;
    b.strokeRect(0.5, 0.5, W - 1, W - 1);
  }

  function update(dt, { world, self, remotes, myId }) {
    if (!visible) return;
    acc += dt;
    if (acc < 0.1) return;
    acc = 0;
    layout();
    const W = canvas.width;
    const k = W / (MAP.half * 2);
    const px = (x) => (x + MAP.half) * k;
    ctx.clearRect(0, 0, W, W);
    ctx.drawImage(base, 0, 0);

    // fissures
    ctx.fillStyle = '#1a1214';
    for (const h of world?.holes || []) {
      ctx.beginPath();
      for (let i = 0; i < 20; i++) {
        const p = pointAt(h.shape, (i / 20) * Math.PI * 2, h.scale);
        const X = px(h.x + p.x);
        const Y = px(h.z + p.z);
        if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
      }
      ctx.closePath();
      ctx.fill();
    }

    // other survivors
    const dot = Math.max(2, W / 70);
    ctx.fillStyle = '#3d6ec4';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = Math.max(1, W / 160);
    for (const [id, r] of remotes?.remotes || []) {
      if (id === myId || r.isSelf || !r.char?.root) continue;
      if (r.target?.alive === false) continue;
      const p = r.char.root.position;
      ctx.beginPath();
      ctx.arc(px(p.x), px(p.z), dot, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // you
    if (self) {
      const x = px(self.x);
      const y = px(self.z);
      const a = self.facing;
      const fx = -Math.sin(a);
      const fz = -Math.cos(a);
      const L = dot * 2.6;
      ctx.fillStyle = '#ef8a3c';
      ctx.beginPath();
      ctx.moveTo(x + fx * L, y + fz * L);
      ctx.lineTo(x - fz * L * 0.55 - fx * L * 0.5, y + fx * L * 0.55 - fz * L * 0.5);
      ctx.lineTo(x + fz * L * 0.55 - fx * L * 0.5, y - fx * L * 0.55 - fz * L * 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }

  function setVisible(v) {
    visible = v;
    canvas.style.display = v ? 'block' : 'none';
    if (v) acc = 1;
  }

  setVisible(false);
  window.addEventListener('resize', layout);
  layout();
  return { update, setVisible };
}
