import * as THREE from 'three';

/**
 * Cut fissure openings out of every ground material (lot, road, sidewalk,
 * curb, plaza, paint) with the exact analytic hole outline, so the shaft
 * walls built from the same outline line up with the cut edge.
 *
 * Outline (shape-local, before rotation):
 *   p(t) = ( cos t · R(t) · rx , sin t · R(t) · rz )
 *   R(t) = baseR · scale · (1 + a1 sin(k1 t + p1) + a2 sin(k2 t + p2))
 * Packed per hole as 3 RGBA float texels of one row in a data texture
 * (uniform arrays would blow the mobile uniform budget at this count):
 *   A = (x, z, baseR·scale, rot)   B = (rx, rz, a1, k1)   C = (p1, a2, k2, p2)
 */
export const MAX_HOLES = 64;
const holeData = new Float32Array(3 * MAX_HOLES * 4);
const holeTex = new THREE.DataTexture(holeData, 3, MAX_HOLES, THREE.RGBAFormat, THREE.FloatType);
holeTex.minFilter = THREE.NearestFilter;
holeTex.magFilter = THREE.NearestFilter;
holeTex.generateMipmaps = false;
holeTex.needsUpdate = true;
const uHoleCount = { value: 0 };
const uHoleTex = { value: holeTex };
const patched = new WeakSet();

/** @param {Array<{x:number,z:number,shape:object,scale:number}>} list */
export function setHolePunches(list) {
  const n = Math.min(MAX_HOLES, list?.length || 0);
  uHoleCount.value = n;
  for (let i = 0; i < n; i++) {
    const { x, z, shape: s, scale = 1 } = list[i];
    holeData.set([
      x, z, s.baseR * scale, s.rot,
      s.rx, s.rz, s.a1, s.k1,
      s.p1, s.a2, s.k2, s.p2,
    ], i * 12);
  }
  holeTex.needsUpdate = true;
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
    shader.uniforms.uHoleTex = uHoleTex;

    shader.vertexShader = `varying vec3 vHoleWorldPos;\n` + shader.vertexShader.replace(
      '#include <project_vertex>',
      `vHoleWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>`
    );

    shader.fragmentShader = `
      varying vec3 vHoleWorldPos;
      uniform int uHoleCount;
      uniform highp sampler2D uHoleTex;
    ` + shader.fragmentShader.replace(
      '#include <clipping_planes_fragment>',
      `#include <clipping_planes_fragment>
      for (int i = 0; i < ${MAX_HOLES}; i++) {
        if (i >= uHoleCount) break;
        vec4 A = texelFetch(uHoleTex, ivec2(0, i), 0);
        vec4 B = texelFetch(uHoleTex, ivec2(1, i), 0);
        vec4 C = texelFetch(uHoleTex, ivec2(2, i), 0);
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

  mat.customProgramCacheKey = () => `${prevKey?.() || 'mat'}|holePunchV3`;
  mat.needsUpdate = true;
  return mat;
}
