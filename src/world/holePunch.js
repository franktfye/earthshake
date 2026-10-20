import * as THREE from 'three';

/**
 * Punch circular holes through ground materials (road / dirt / lines)
 * so deep fissure funnels are visible — asphalt no longer fills the pit.
 */
const MAX_HOLES = 16;
const holeVecs = Array.from({ length: MAX_HOLES }, () => new THREE.Vector4());
const uHoleCount = { value: 0 };
const uHoles = { value: holeVecs };
const patched = new WeakSet();

export function setHolePunches(list) {
  const n = Math.min(MAX_HOLES, list?.length || 0);
  uHoleCount.value = n;
  for (let i = 0; i < MAX_HOLES; i++) {
    if (i < n) {
      const h = list[i];
      holeVecs[i].set(h.x, h.z, h.radius, 1);
    } else {
      holeVecs[i].set(0, 0, 0, 0);
    }
  }
}

export function clearHolePunches() {
  setHolePunches([]);
}

/** Chain onBeforeCompile so cel tint + hole discard both apply. */
export function patchGroundMaterial(mat) {
  if (!mat || patched.has(mat)) return;
  patched.add(mat);

  const prevCompile = mat.onBeforeCompile
    ? mat.onBeforeCompile.bind(mat)
    : () => {};
  const prevKey = mat.customProgramCacheKey?.bind(mat);

  mat.onBeforeCompile = (shader, renderer) => {
    prevCompile(shader, renderer);
    shader.uniforms.uHoleCount = uHoleCount;
    shader.uniforms.uHoles = uHoles;

    shader.vertexShader = `varying vec3 vHoleWorldPos;\n` + shader.vertexShader;
    if (!shader.vertexShader.includes('vHoleWorldPos =')) {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `vHoleWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#include <project_vertex>`
      );
    }

    shader.fragmentShader = `
      varying vec3 vHoleWorldPos;
      uniform int uHoleCount;
      uniform vec4 uHoles[${MAX_HOLES}];
    ` + shader.fragmentShader;

    if (!shader.fragmentShader.includes('uHoleCount) break')) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
        {
          for (int i = 0; i < ${MAX_HOLES}; i++) {
            if (i >= uHoleCount) break;
            vec2 d = vHoleWorldPos.xz - uHoles[i].xy;
            float rr = uHoles[i].z * uHoles[i].z;
            if (dot(d, d) < rr) discard;
          }
        }`
      );
    }
  };

  mat.customProgramCacheKey = () => `${prevKey?.() || 'mat'}|holePunch16`;
  mat.needsUpdate = true;
}
