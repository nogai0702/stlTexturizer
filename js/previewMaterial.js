import * as THREE from 'three';

// Mapping mode constants (must match index.html <option value="…">)
export const MODE_PLANAR_XY   = 0;
export const MODE_PLANAR_XZ   = 1;
export const MODE_PLANAR_YZ   = 2;
export const MODE_CYLINDRICAL = 3;
export const MODE_SPHERICAL   = 4;
export const MODE_TRIPLANAR   = 5;
export const MODE_CUBIC       = 6;

// ── GLSL source ──────────────────────────────────────────────────────────────
//
// Preview strategy: NO vertex displacement.
// All UV projection is done in the fragment shader so the underlying mesh
// geometry is never modified.  The displacement map is visualised via
// per-fragment bump mapping (perturbing the shading normal from screen-space
// height derivatives).  `amplitude` scales the bump intensity only.

const vertexShader = /* glsl */`
  precision highp float;

  varying vec3 vModelPos;    // model-space position  → UV computation in fragment
  varying vec3 vModelNormal; // model-space normal    → stable UV blending (triplanar/cubic)
  varying vec3 vViewPos;     // view-space position   → TBN & specular
  varying vec3 vNormal;      // view-space normal     → lighting

  void main() {
    vModelPos    = position;
    vModelNormal = normalize(normal);
    vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
    vViewPos     = mvPos.xyz;
    vNormal      = normalize(normalMatrix * normal);
    gl_Position  = projectionMatrix * mvPos;
  }
`;

const fragmentShader = /* glsl */`
  precision highp float;

  uniform sampler2D displacementMap;
  uniform int       mappingMode;
  uniform vec2      scaleUV;
  uniform float     amplitude;
  uniform vec2      offsetUV;
  uniform float     rotation;
  uniform vec3      boundsMin;
  uniform vec3      boundsSize;
  uniform vec3      boundsCenter;
  uniform float     bottomAngleLimit; // degrees from horizontal; 0 = disabled
  uniform float     topAngleLimit;    // degrees from horizontal; 0 = disabled

  varying vec3 vModelPos;
  varying vec3 vModelNormal;
  varying vec3 vViewPos;
  varying vec3 vNormal;

  const float PI     = 3.14159265358979;
  const float TWO_PI = 6.28318530717959;

  // Sample after applying scale + tiling
  float sampleMap(vec2 rawUV) {
    vec2 uv = rawUV / scaleUV + offsetUV;
    // rotate around tile centre
    float c = cos(rotation); float s = sin(rotation);
    uv -= 0.5;
    uv  = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    uv += 0.5;
    return texture2D(displacementMap, fract(uv)).r;
  }

  // Height at this fragment for all projection modes.
  // Uses vModelPos / vModelNormal (model-space) so UV is stable as the camera orbits.
  float getHeight() {
    vec3 pos = vModelPos;
    vec3 MN  = vModelNormal;  // model-space normal
    vec3 rel = pos - boundsCenter;
    float maxDim = max(boundsSize.x, max(boundsSize.y, boundsSize.z));
    float md = max(maxDim, 1e-4);

    if (mappingMode == 0) {
      return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));

    } else if (mappingMode == 1) {
      return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 2) {
      return sampleMap(vec2((pos.y - boundsMin.y) / md, (pos.z - boundsMin.z) / md));

    } else if (mappingMode == 3) {
      // Cylindrical around Z axis (Z is up) with automatic caps.
      //
      // Side: V is arc-length-normalised (divided by circumference C = 2πr)
      //   so that scaleU = scaleV gives square, un-stretched texels on the surface.
      //
      // Cap (|normalZ| > 0.5): planar XY centred on the cylinder axis, one tile
      //   fills the diameter × diameter square so the disc looks fully textured.
      float r = max(boundsSize.x, boundsSize.y) * 0.5;
      float C = TWO_PI * max(r, 1e-4);
      if (abs(vModelNormal.z) > 0.7) {
        // Cap face — normalise by C so one tile = same world size as on the side
        return sampleMap(vec2(
          rel.x / C + 0.5,
          rel.y / C + 0.5
        ));
      }
      // Side face
      return sampleMap(vec2(
        atan(rel.y, rel.x) / TWO_PI + 0.5,
        (pos.z - boundsMin.z) / C
      ));

    } else if (mappingMode == 4) {
      // Spherical — Z is up
      float r     = length(rel);
      float phi   = acos(clamp(rel.z / max(r, 1e-4), -1.0, 1.0));
      float theta = atan(rel.y, rel.x);
      return sampleMap(vec2(theta / TWO_PI + 0.5, phi / PI));

    } else if (mappingMode == 5) {
      // Triplanar – smooth blend using model-space normal (stable regardless of camera)
      vec3 blend = abs(MN);
      blend = pow(blend, vec3(4.0));
      blend /= dot(blend, vec3(1.0)) + 1e-4;

      float hXY = sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));
      float hXZ = sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));
      float hYZ = sampleMap(vec2((pos.y - boundsMin.y) / md, (pos.z - boundsMin.z) / md));

      return hXY * blend.z + hXZ * blend.y + hYZ * blend.x;

    } else {
      // Cubic (box) – hard-edge face selection using model-space normal
      // Picks the single planar projection whose axis is most aligned with the face normal.
      vec3 absN = abs(MN);
      if (absN.x >= absN.y && absN.x >= absN.z) {
        return sampleMap(vec2((pos.z - boundsMin.z) / md, (pos.y - boundsMin.y) / md));
      } else if (absN.y >= absN.x && absN.y >= absN.z) {
        return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.z - boundsMin.z) / md));
      } else {
        return sampleMap(vec2((pos.x - boundsMin.x) / md, (pos.y - boundsMin.y) / md));
      }
    }
  }

  void main() {
    vec3 N = normalize(vNormal);
    float h = getHeight();
    // ── Surface angle masking (FDM: suppress texture on near-horizontal faces) ────
    // Use a 15° smoothstep fade above the threshold so the bump tapers gradually
    // into the masked region rather than cutting off abruptly at the boundary edge.
    float surfaceAngle = degrees(acos(clamp(abs(vModelNormal.z), 0.0, 1.0)));
    float maskBlend = 1.0;
    float FADE = 15.0;
    if (vModelNormal.z <  0.0 && bottomAngleLimit >= 1.0)
      maskBlend = min(maskBlend, smoothstep(bottomAngleLimit, bottomAngleLimit + FADE, surfaceAngle));
    if (vModelNormal.z >= 0.0 && topAngleLimit >= 1.0)
      maskBlend = min(maskBlend, smoothstep(topAngleLimit, topAngleLimit + FADE, surfaceAngle));
    h = mix(0.5, h, maskBlend); // blend toward neutral grey (zero-gradient → no bump)
    // ── Bump mapping via screen-space height derivatives ──────────────────
    // dFdx/dFdy give the height change per screen pixel → height gradient
    float dhx = dFdx(h);
    float dhy = dFdy(h);

    // Screen-space surface tangent / bitangent, projected onto the surface plane
    vec3 dp1 = dFdx(vViewPos);
    vec3 dp2 = dFdy(vViewPos);

    vec3 T = dp1 - dot(dp1, N) * N;
    vec3 B = dp2 - dot(dp2, N) * N;
    float lenT = length(T);
    float lenB = length(B);
    T = lenT > 1e-5 ? T / lenT : vec3(1.0, 0.0, 0.0);
    B = lenB > 1e-5 ? B / lenB : vec3(0.0, 1.0, 0.0);

    // Normalise bump strength by position derivative so the effect is
    // independent of zoom level / mesh scale.
    float posScale = max(length(dp1) + length(dp2), 1e-6);
    float bumpStr  = amplitude * 1.2 / posScale;

    vec3 bumpN = normalize(N - bumpStr * (dhx * T + dhy * B));

    // ── Shading ───────────────────────────────────────────────────────────
    // Base colour: cool-to-warm tint driven by the displacement height value
    // so the texture pattern is clearly visible even without bump lighting.
    vec3 lo = vec3(0.18, 0.20, 0.35);
    vec3 hi = vec3(0.90, 0.84, 0.68);
    vec3 baseColor = mix(lo, hi, h);

    vec3 L1 = normalize(vec3( 0.5,  0.8,  1.0));
    vec3 L2 = normalize(vec3(-0.5, -0.2, -0.6));
    vec3 V  = normalize(-vViewPos);

    float diff1 = max(dot(bumpN, L1), 0.0);
    float diff2 = max(dot(bumpN, L2), 0.0) * 0.35;

    vec3 H1   = normalize(L1 + V);
    float spec = pow(max(dot(bumpN, H1), 0.0), 48.0) * 0.55;

    vec3 color = baseColor * 0.60                                        // strong ambient — texture always visible
               + baseColor * diff1 * vec3(1.00, 0.97, 0.90) * 0.45      // key light
               + baseColor * diff2 * vec3(0.40, 0.50, 0.80) * 0.20      // fill light
               + vec3(spec);                                             // specular

    gl_FragColor = vec4(color, 1.0);
  }
`;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a ShaderMaterial for the displacement preview.
 * @param {THREE.Texture|null} displacementTexture
 * @param {object} settings  – { mappingMode, scaleU, scaleV, amplitude, offsetU, offsetV, bounds }
 */
export function createPreviewMaterial(displacementTexture, settings) {
  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: buildUniforms(displacementTexture, settings),
    side: THREE.DoubleSide,
  });
  return mat;
}

/**
 * Update existing ShaderMaterial uniforms in-place (no recreate).
 */
export function updateMaterial(material, displacementTexture, settings) {
  const u = material.uniforms;
  if (displacementTexture && u.displacementMap.value !== displacementTexture) {
    u.displacementMap.value = displacementTexture;
  }
  u.mappingMode.value   = settings.mappingMode;
  u.scaleUV.value.set(settings.scaleU, settings.scaleV);
  u.amplitude.value     = settings.amplitude;
  u.offsetUV.value.set(settings.offsetU, settings.offsetV);
  u.rotation.value      = (settings.rotation ?? 0) * Math.PI / 180;
  if (settings.bounds) {
    u.boundsMin.value.copy(settings.bounds.min);
    u.boundsSize.value.copy(settings.bounds.size);
    u.boundsCenter.value.copy(settings.bounds.center);
  }
  u.bottomAngleLimit.value = settings.bottomAngleLimit ?? 5.0;
  u.topAngleLimit.value    = settings.topAngleLimit    ?? 0.0;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function buildUniforms(tex, settings) {
  const b = settings.bounds || {
    min:    new THREE.Vector3(),
    size:   new THREE.Vector3(1, 1, 1),
    center: new THREE.Vector3(),
  };
  return {
    displacementMap: { value: tex || createFallbackTexture() },
    mappingMode:     { value: settings.mappingMode ?? MODE_TRIPLANAR },
    scaleUV:         { value: new THREE.Vector2(settings.scaleU ?? 1, settings.scaleV ?? 1) },
    amplitude:       { value: settings.amplitude ?? 1.0 },
    offsetUV:        { value: new THREE.Vector2(settings.offsetU ?? 0, settings.offsetV ?? 0) },
    rotation:        { value: ((settings.rotation ?? 0) * Math.PI / 180) },
    boundsMin:        { value: b.min.clone() },
    boundsSize:       { value: b.size.clone() },
    boundsCenter:     { value: b.center.clone() },
    bottomAngleLimit: { value: settings.bottomAngleLimit ?? 5.0 },
    topAngleLimit:    { value: settings.topAngleLimit    ?? 0.0 },
  };
}

function createFallbackTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 4;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 4, 4);
  const t = new THREE.CanvasTexture(canvas);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
