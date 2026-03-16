import * as THREE from 'three';
import { computeUV } from './mapping.js';

/**
 * Apply displacement to every vertex of a non-indexed BufferGeometry.
 *
 * For each vertex:
 *   1. Compute UV with the same math used in the GLSL preview shader (mapping.js).
 *   2. Bilinear-sample the greyscale ImageData at that UV.
 *   3. Move the vertex along its normal by:  grey * amplitude
 *
 * @param {THREE.BufferGeometry} geometry  – non-indexed (from subdivide())
 * @param {ImageData}            imageData – raw pixel data from Canvas2D
 * @param {number}               imgWidth
 * @param {number}               imgHeight
 * @param {object}               settings  – { mappingMode, scaleU, scaleV, amplitude, offsetU, offsetV }
 * @param {object}               bounds    – { min, max, center, size } (THREE.Vector3)
 * @param {function}             [onProgress]
 * @returns {THREE.BufferGeometry}  new non-indexed geometry with displaced positions
 */
export function applyDisplacement(geometry, imageData, imgWidth, imgHeight, settings, bounds, onProgress) {
  const posAttr = geometry.attributes.position;
  const nrmAttr = geometry.attributes.normal;
  const count   = posAttr.count;

  const newPos = new Float32Array(count * 3);
  const newNrm = new Float32Array(count * 3);

  const tmpPos = new THREE.Vector3();
  const tmpNrm = new THREE.Vector3();

  const REPORT_EVERY = 5000;

  for (let i = 0; i < count; i++) {
    tmpPos.fromBufferAttribute(posAttr, i);
    tmpNrm.fromBufferAttribute(nrmAttr, i);

    const uvResult = computeUV(tmpPos, tmpNrm, settings.mappingMode, settings, bounds);

    let grey;
    if (uvResult.triplanar) {
      // Weighted blend of three samples
      grey = 0;
      for (const s of uvResult.samples) {
        grey += sampleBilinear(imageData.data, imgWidth, imgHeight, s.u, s.v) * s.w;
      }
    } else {
      grey = sampleBilinear(imageData.data, imgWidth, imgHeight, uvResult.u, uvResult.v);
    }

    const disp = grey * settings.amplitude;

    newPos[i*3]   = tmpPos.x + tmpNrm.x * disp;
    newPos[i*3+1] = tmpPos.y + tmpNrm.y * disp;
    newPos[i*3+2] = tmpPos.z + tmpNrm.z * disp;

    newNrm[i*3]   = tmpNrm.x;
    newNrm[i*3+1] = tmpNrm.y;
    newNrm[i*3+2] = tmpNrm.z;

    if (onProgress && i % REPORT_EVERY === 0) onProgress(i / count);
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(newPos, 3));
  out.setAttribute('normal',   new THREE.BufferAttribute(newNrm, 3));
  // Recompute face normals for correct lighting in exported STL
  out.computeVertexNormals();
  return out;
}

// ── Bilinear sampler ─────────────────────────────────────────────────────────

/**
 * Sample a greyscale value (0–1) from raw RGBA ImageData using
 * bilinear interpolation. UV is tiled via mod 1.
 */
function sampleBilinear(data, w, h, u, v) {
  // Ensure [0,1) — guard against floating-point edge cases
  u = ((u % 1) + 1) % 1;
  v = ((v % 1) + 1) % 1;

  const fx = u * (w - 1);
  const fy = v * (h - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = fx - x0;
  const ty = fy - y0;

  // Red channel — image is greyscale so R == G == B
  const v00 = data[(y0 * w + x0) * 4] / 255;
  const v10 = data[(y0 * w + x1) * 4] / 255;
  const v01 = data[(y1 * w + x0) * 4] / 255;
  const v11 = data[(y1 * w + x1) * 4] / 255;

  return v00 * (1-tx) * (1-ty)
       + v10 * tx * (1-ty)
       + v01 * (1-tx) * ty
       + v11 * tx * ty;
}
