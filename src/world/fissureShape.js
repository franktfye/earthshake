/**
 * Analytic fissure outline shared by the ground cut shader (holePunch.js),
 * the shaft mesh, the warning decal and the kill test — all four agree.
 *
 * Kinds:
 *  - pit:   round-ish sinkhole, smooth low-frequency lobes
 *  - chasm: long rotated crevasse (aspect 2.4–3.8)
 *  - crack: narrow jagged split 0.7–0.9 m wide, 3–8 m long — fits any street
 */

export function makeShape(rng, kind = rng.chance(0.5) ? 'pit' : 'chasm') {
  if (kind === 'crack') {
    const baseR = rng.range(0.36, 0.46);
    return {
      kind,
      baseR,
      rx: rng.range(4.5, 9),
      rz: 1,
      rot: rng.range(0, Math.PI),
      a1: rng.range(0.12, 0.2),
      k1: rng.pick([5, 7, 9]),
      p1: rng.range(0, Math.PI * 2),
      a2: rng.range(0.06, 0.12),
      k2: rng.pick([13, 15, 17]),
      p2: rng.range(0, Math.PI * 2),
    };
  }
  if (kind === 'chasm') {
    const baseR = rng.range(0.7, 0.95);
    return {
      kind,
      baseR,
      rx: rng.range(2.4, 3.8),
      rz: 1,
      rot: rng.range(0, Math.PI),
      a1: rng.range(0.12, 0.22),
      k1: rng.pick([3, 4, 5]),
      p1: rng.range(0, Math.PI * 2),
      a2: rng.range(0.05, 0.1),
      k2: rng.pick([7, 9, 11]),
      p2: rng.range(0, Math.PI * 2),
    };
  }
  return {
    kind: 'pit',
    baseR: rng.range(1.1, 1.8),
    rx: rng.range(0.9, 1.12),
    rz: rng.range(0.9, 1.12),
    rot: rng.range(0, Math.PI),
    a1: rng.range(0.06, 0.14),
    k1: rng.pick([2, 3]),
    p1: rng.range(0, Math.PI * 2),
    a2: rng.range(0.03, 0.08),
    k2: rng.pick([4, 5, 6]),
    p2: rng.range(0, Math.PI * 2),
  };
}

/** Polar radius in unit (pre-rx/rz) space. */
export function radiusAt(s, t, scale = 1) {
  return s.baseR * scale * (1 + s.a1 * Math.sin(s.k1 * t + s.p1) + s.a2 * Math.sin(s.k2 * t + s.p2));
}

/** World-space offset (dx, dz) of outline parameter t, optionally pushed out by `grow` scale. */
export function pointAt(s, t, scale = 1, out = { x: 0, z: 0 }) {
  const r = radiusAt(s, t, scale);
  const lx = Math.cos(t) * r * s.rx;
  const lz = Math.sin(t) * r * s.rz;
  const c = Math.cos(s.rot);
  const n = Math.sin(s.rot);
  out.x = c * lx - n * lz;
  out.z = n * lx + c * lz;
  return out;
}

/** Inside test for an offset from the hole centre (matches shader exactly). */
export function containsOffset(s, dx, dz, scale = 1) {
  const c = Math.cos(s.rot);
  const n = Math.sin(s.rot);
  const qx = (c * dx + n * dz) / s.rx;
  const qz = (-n * dx + c * dz) / s.rz;
  const t = Math.atan2(qz, qx);
  const r = radiusAt(s, t, scale);
  return qx * qx + qz * qz < r * r;
}

/** Conservative bounding radius. */
export function boundR(s, scale = 1) {
  return s.baseR * scale * (1 + Math.abs(s.a1) + Math.abs(s.a2)) * Math.max(s.rx, s.rz);
}

/** Outline sampled into `n` world-space offsets. */
export function outlinePts(s, n = 96, scale = 1) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const p = pointAt(s, (i / n) * Math.PI * 2, scale);
    pts.push({ x: p.x, z: p.z });
  }
  return pts;
}
