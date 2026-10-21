import * as THREE from 'three';

/**
 * Cut fissure openings out of every ground material (lot, road, sidewalk,
 * curb, plaza, paint) with the exact analytic hole outline, so the shaft
 * walls built from the same outline line up with the cut edge.
 *
 * Outline (shape-local, before rotation):
 *   p(t) = ( cos t · R(t) · rx , sin t · R(t) · rz )
 *   R(t) = baseR · scale · (1 + a1 sin(k1 t + p1) + a2 sin(k2 t + p2))
 * Packed per hole:
 *   A = (x, z, baseR·scale, rot)   B = (rx, rz, a1, k1)   C = (p1, a2, k2, p2)
 */
export const MAX_HOLES = 32;
const holeA = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4());
const holeB = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4(1, 1, 0, 0));
const holeC = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4());
const uHoleCount = { value: 0 };
const uHoleA = { value: holeA };
const uHoleB = { value: holeB };
const uHoleC = { value: holeC };
const patched = new WeakSet();

/** @param {Array<{x:number,z:number,shape:object,scale:number}>} list */
export function setHolePunches(list) {
  const n = Math.min(MAX_HOLES, list?.length || 0);
  uHoleCount.value = n;
  for (let i = 0; i < n; i++) {
    const { x, z, shape: s, scale = 1 } = list[i];
    holeA[i].set(x, z, s.baseR * scale, s.rot);
    holeB[i].set(s.rx, s.rz, s.a1, s.k1);
    holeC[i].set(s.p1, s.a2, s.k2, s.p2);
  }
}

export function clearHolePunches() {
  setHolePunches([]);
}

/** Chain onBeforeCompile so cel tint + hole discard both apply. */
export function patchGroundMaterial(mat) {
  if (!mat || patched.has(mat)) return mat;
  patched.add(mat);

  const prevCompile = mat.onBeforeCompile
    ? mat.onBeforeCompile.bind(mat)
    : () => {};
  const prevKey = mat.customProgramCacheKey?.bind(mat);

  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile(shader, renderer);
    shader.uniforms.uHoleCount = uHoleCount;
    shader.uniforms.uHoleA = uHoleA;
    shader.uniforms.uHoleB = uHoleB;
    shader.uniforms.uHoleC = uHoleC;

    shader.vertexShader = `varying vec3 vHoleWorldPos;\n` + shader.vertexShader.replace(
      '#include <project_vertex>',
      `vHoleWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>`
    );

    shader.fragmentShader = `
      varying vec3 vHoleWorldPos;
      uniform int uHoleCount;
      uniform vec4 uHoleA[${MAX_HOLES}];
      uniform vec4 uHoleB[${MAX_HOLES}];
      uniform vec4 uHoleC[${MAX_HOLES}];
    ` + shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      for (int i = 0; i < ${MAX_HOLES}; i++) {
        if (i >= uHoleCount) break;
        vec4 A = uHoleA[i];
        vec4 B = uHoleB[i];
        vec4 C = uHoleC[i];
        vec2 d = vHoleWorldPos.xz - A.xy;
        float lim = A.z * (1.0 + abs(B.z) + abs(C.y)) * max(B.x, B.y);
        if (dot(d, d) > lim * lim) continue;
        float cr = cos(A.w);
        float sr = sin(A.w);
        vec2 q = vec2(cr * d.x + sr * d.y, -sr * d.x + cr * d.y) / B.xy;
        float t = atan(q.y, q.x);
        float R = A.z * (1.0 + B.z * sin(B.w * t + C.x) + C.y * sin(C.z * t + C.w));
        if (dot(q, q) < R * R) discard;
      }`
    );
  };

  mat.customProgramCacheKey = () => `${prevKey?.() || 'mat'}|holePunchV2`;
  mat.needsUpdate = true;
  return mat;
}
