/**
 * CPU-side UV mapping — exact JavaScript mirror of the GLSL in previewMaterial.js.
 * All functions take Three.js Vector3 objects for position/normal and
 * a bounds object { min, max, center, size } (all THREE.Vector3).
 */

export const MODE_PLANAR_XY   = 0;
export const MODE_PLANAR_XZ   = 1;
export const MODE_PLANAR_YZ   = 2;
export const MODE_CYLINDRICAL = 3;
export const MODE_SPHERICAL   = 4;
export const MODE_TRIPLANAR   = 5;
export const MODE_CUBIC       = 6;

const TWO_PI = Math.PI * 2;

/**
 * Compute normalised UV coordinates [0, 1) (tiling) for a vertex.
 *
 * @param {{ x:number, y:number, z:number }} pos      vertex position
 * @param {{ x:number, y:number, z:number }} normal   vertex normal (unit)
 * @param {number}  mode    one of the MODE_* constants
 * @param {{ scaleU:number, scaleV:number, offsetU:number, offsetV:number }} settings
 * @param {{ min, max, center, size }} bounds           THREE.Vector3 fields
 * @returns {{ u:number, v:number }}                    tiled UV after scale+offset
 */
export function computeUV(pos, normal, mode, settings, bounds) {
  const { min, size, center } = bounds;
  const { scaleU, scaleV, offsetU, offsetV } = settings;
  const rotRad = (settings.rotation ?? 0) * Math.PI / 180;
  const maxDim = Math.max(size.x, size.y, size.z);
  const md     = Math.max(maxDim, 1e-6);

  let u = 0, v = 0;

  switch (mode) {

    case MODE_PLANAR_XY: {
      u = (pos.x - min.x) / md;
      v = (pos.y - min.y) / md;
      break;
    }

    case MODE_PLANAR_XZ: {
      u = (pos.x - min.x) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_PLANAR_YZ: {
      u = (pos.y - min.y) / md;
      v = (pos.z - min.z) / md;
      break;
    }

    case MODE_CYLINDRICAL: {
      // Cylindrical around Z axis with automatic caps.
      //
      // Side: V arc-length-normalised by circumference C = 2πr so that
      //   scaleU = scaleV gives un-stretched square texels on the surface.
      //
      // Cap (|normalZ| > 0.5): planar XY centred on the axis, scaled to the
      //   diameter so one tile covers the full cap disc.
      const r  = Math.max(size.x, size.y) * 0.5;
      const C  = TWO_PI * Math.max(r, 1e-6);
      const rx = pos.x - center.x;
      const ry = pos.y - center.y;
      if (Math.abs(normal.z) > 0.7) {
        // Cap face — normalise by C so one tile = same world size as on the side
        u = rx / C + 0.5;
        v = ry / C + 0.5;
      } else {
        // Side face
        const theta = Math.atan2(ry, rx);
        u = (theta / TWO_PI) + 0.5;
        v = (pos.z - min.z) / C;
      }
      break;
    }

    case MODE_SPHERICAL: {
      const rx = pos.x - center.x;
      const ry = pos.y - center.y;
      const rz = pos.z - center.z;
      const r  = Math.sqrt(rx*rx + ry*ry + rz*rz);
      const phi   = Math.acos(Math.max(-1, Math.min(1, rz / Math.max(r, 1e-6)))); // [0, PI], Z is up
      const theta = Math.atan2(ry, rx);              // [-PI, PI]
      u = (theta / TWO_PI) + 0.5;
      v = phi / Math.PI;
      break;
    }

    case MODE_CUBIC: {
      const ax = Math.abs(normal.x);
      const ay = Math.abs(normal.y);
      const az = Math.abs(normal.z);
      let uRaw, vRaw;
      if (ax >= ay && ax >= az) {
        uRaw = (pos.z - min.z) / md;
        vRaw = (pos.y - min.y) / md;
      } else if (ay >= ax && ay >= az) {
        uRaw = (pos.x - min.x) / md;
        vRaw = (pos.z - min.z) / md;
      } else {
        uRaw = (pos.x - min.x) / md;
        vRaw = (pos.y - min.y) / md;
      }
      return applyTransform(uRaw, vRaw, scaleU, scaleV, offsetU, offsetV, rotRad);
    }

    case MODE_TRIPLANAR:
    default: {
      // World-space normal blending
      const ax = Math.abs(normal.x);
      const ay = Math.abs(normal.y);
      const az = Math.abs(normal.z);
      const pw = 4.0;
      const bx = Math.pow(ax, pw);
      const by = Math.pow(ay, pw);
      const bz = Math.pow(az, pw);
      const sum = bx + by + bz + 1e-6;
      const wx = bx / sum;
      const wy = by / sum;
      const wz = bz / sum;

      const uvXY = {
        u: (pos.x - min.x) / md,
        v: (pos.y - min.y) / md,
        w: wz,
      };
      const uvXZ = {
        u: (pos.x - min.x) / md,
        v: (pos.z - min.z) / md,
        w: wy,
      };
      const uvYZ = {
        u: (pos.y - min.y) / md,
        v: (pos.z - min.z) / md,
        w: wx,
      };

      // Apply scale+offset+rotation and tile each independently
      return {
        triplanar: true,
        samples: [
          { ...applyTransform(uvXY.u, uvXY.v, scaleU, scaleV, offsetU, offsetV, rotRad), w: uvXY.w },
          { ...applyTransform(uvXZ.u, uvXZ.v, scaleU, scaleV, offsetU, offsetV, rotRad), w: uvXZ.w },
          { ...applyTransform(uvYZ.u, uvYZ.v, scaleU, scaleV, offsetU, offsetV, rotRad), w: uvYZ.w },
        ],
      };
    }
  }

  return applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, rotRad);
}

function applyTransform(u, v, scaleU, scaleV, offsetU, offsetV, rotRad) {
  let uu = u / scaleU + offsetU;
  let vv = v / scaleV + offsetV;
  if (rotRad !== 0) {
    const c = Math.cos(rotRad), s = Math.sin(rotRad);
    uu -= 0.5; vv -= 0.5;
    const ru = c * uu - s * vv;
    const rv = s * uu + c * vv;
    uu = ru + 0.5; vv = rv + 0.5;
  }
  return { triplanar: false, u: fract(uu), v: fract(vv) };
}

/** Fractional part, always positive (mirrors GLSL fract) */
function fract(x) { return x - Math.floor(x); }
