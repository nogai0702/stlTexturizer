/**
 * QEM (Quadric Error Metric) mesh decimation.
 *
 * Algorithm: Garland & Heckbert 1997, with the three safety guards from
 * PrusaSlicer's QuadricEdgeCollapse.cpp that eliminate holes, spikes and
 * non-manifold edges:
 *
 *   Guard 1 – Boundary edge protection
 *     Never collapse an edge shared by < 2 active faces.
 *     The primary cause of holes in open STL meshes.
 *
 *   Guard 2 – Link-condition (non-manifold / pinch prevention)
 *     Common neighbours of v1/v2 must equal exactly the apex vertices of
 *     their shared triangles.  Extra common neighbours mean collapsing would
 *     fuse disconnected surface regions → non-manifold edge.
 *
 *   Guard 3 – Normal-flip rejection
 *     Recompute every affected face normal after the hypothetical collapse.
 *     dot(original, new) < 0.2 (~78°) → reject.  Eliminates spikes / pits.
 *
 * Crease preservation (Garland & Heckbert §3.2):
 *   Edges where adjacent face normals diverge by more than CREASE_COS receive
 *   high-weight penalty planes added to both endpoint quadrics.  This raises
 *   the QEM cost of any collapse that would move a vertex off a sharp feature,
 *   ensuring smooth regions are decimated first while creases are kept intact.
 *
 * Performance notes:
 *   - Struct-of-arrays typed-array heap avoids per-entry object allocation.
 *   - Numeric edge keys (v_lo * MAX_V + v_hi) replace template strings.
 *   - Vertex deduplication uses a numeric spatial-grid Map instead of strings.
 *   - Link-violation check packs sorted face triple into two Numbers to avoid
 *     string allocation.
 *   - Progress callback fires at most every 512 collapses.
 *
 * @param {THREE.BufferGeometry} geometry        non-indexed input
 * @param {number}               targetTriangles desired output face count
 * @param {function}             [onProgress]    callback(0–1)
 * @returns {THREE.BufferGeometry}
 */

import * as THREE from 'three';

const QUANT         = 1e4;
const FLIP_DOT      = 0.2;  // cos ~78° — reject collapse if new normal deviates more
const CREASE_COS    = 0.5;  // cos 60° — edges sharper than this are treated as creases
const CREASE_WEIGHT = 1e4;  // quadric penalty weight for crease edges

// ── Public API ───────────────────────────────────────────────────────────────

export function decimate(geometry, targetTriangles, onProgress) {
  const { positions, faces, vertCount, faceCount } = buildIndexed(geometry);

  if (faceCount <= targetTriangles) return buildOutput(positions, faces, faceCount);

  // Per-vertex error quadrics (10 doubles = upper triangle of symmetric 4×4)
  const quadrics = new Float64Array(vertCount * 10);
  initQuadrics(quadrics, positions, faces, faceCount);
  addCreaseQuadrics(quadrics, positions, faces, faceCount);

  // Vertex → set of incident face indices (Int32Arrays for cache efficiency)
  const vertFaces  = buildAdjacency(faces, faceCount, vertCount);
  const active     = new Uint8Array(vertCount).fill(1);
  // Per-vertex version counter: incremented whenever a vertex's quadric or
  // position changes.  Heap entries carry the versions at push time; any
  // entry whose versions no longer match is stale and is skipped.
  const version    = new Uint32Array(vertCount);
  let   activeFaces = faceCount;

  // Seed min-heap with one entry per unique edge.
  // Use BigInt keys to handle any vertex count without integer overflow.
  const heap     = new SoAHeap(Math.min(faceCount * 3, 1 << 24));
  const seedSeen = new Set();
  const _vc = BigInt(vertCount);
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const va = faces[f * 3 + e];
      const vb = faces[f * 3 + ((e + 1) % 3)];
      const lo = va < vb ? va : vb, hi = va < vb ? vb : va;
      const ek = BigInt(lo) * _vc + BigInt(hi);
      if (!seedSeen.has(ek)) { seedSeen.add(ek); pushEdge(heap, quadrics, positions, version, va, vb); }
    }
  }
  seedSeen.clear();

  const initFaces  = activeFaces;
  const toRemove   = initFaces - targetTriangles;
  let   lastProg   = 0;
  let   collapses  = 0;

  while (activeFaces > targetTriangles && heap.size() > 0) {
    const idx = heap.pop();
    if (idx < 0) break;

    const v1 = heap.getV1(idx), v2 = heap.getV2(idx);
    const ver1 = heap.getVer1(idx), ver2 = heap.getVer2(idx);
    const px = heap.getPx(idx), py = heap.getPy(idx), pz = heap.getPz(idx);

    // Stale-entry checks (lazy deletion)
    if (!active[v1] || !active[v2]) continue;
    if (version[v1] !== ver1 || version[v2] !== ver2) continue;
    if (!shareActiveFace(faces, vertFaces, v1, v2)) continue;

    // ── Three safety guards ───────────────────────────────────────────────────
    if (isBoundaryEdge(faces, vertFaces, v1, v2))   continue;  // Guard 1
    if (hasLinkViolation(faces, vertFaces, v1, v2)) continue;  // Guard 2
    if (checkFlipped(positions, vertFaces, faces, v1, v2, px, py, pz)) continue; // Guard 3 v1-side
    if (checkFlipped(positions, vertFaces, faces, v2, v1, px, py, pz)) continue; // Guard 3 v2-side

    // ── Collapse: keep v1 at new position, remove v2 ─────────────────────────
    positions[v1 * 3]     = px;
    positions[v1 * 3 + 1] = py;
    positions[v1 * 3 + 2] = pz;
    mergeQuadric(quadrics, v1, v2);
    version[v1]++;  // v1's quadric and position changed — invalidate old heap entries

    for (const f of vertFaces[v2]) {
      if (faces[f * 3] < 0) continue;
      for (let k = 0; k < 3; k++) {
        if (faces[f * 3 + k] === v2) faces[f * 3 + k] = v1;
      }
      const fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
      if (fa === fb || fb === fc || fa === fc) {
        vertFaces[fa]?.delete(f);
        vertFaces[fb]?.delete(f);
        vertFaces[fc]?.delete(f);
        faces[f * 3] = faces[f * 3 + 1] = faces[f * 3 + 2] = -1;
        activeFaces--;
      } else {
        vertFaces[v1].add(f);
      }
    }
    vertFaces[v2].clear();
    active[v2] = 0;

    // Re-push edges for v1's updated neighbourhood
    const neighbors = new Set();
    for (const f of vertFaces[v1]) {
      if (faces[f * 3] < 0) continue;
      for (let k = 0; k < 3; k++) {
        const nb = faces[f * 3 + k];
        if (nb !== v1) neighbors.add(nb);
      }
    }
    for (const nb of neighbors) {
      if (active[nb]) pushEdge(heap, quadrics, positions, version, v1, nb);
    }

    if (onProgress && (++collapses & 511) === 0) {
      const p = Math.min(1, (initFaces - activeFaces) / toRemove);
      if (p - lastProg > 0.015) { onProgress(p); lastProg = p; }
    }
  }

  if (onProgress) onProgress(1);
  return buildOutput(positions, faces, faceCount);
}

// ── Guard 1: Boundary edge protection ───────────────────────────────────────
// An edge is a boundary if fewer than 2 active faces share it.
// Collapsing boundary edges is the primary cause of holes in open meshes.

function isBoundaryEdge(faces, vertFaces, v1, v2) {
  let shared = 0;
  for (const f of vertFaces[v1]) {
    if (faces[f * 3] < 0) continue;
    const fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    if (fa === v2 || fb === v2 || fc === v2) { shared++; if (shared >= 2) return false; }
  }
  return shared < 2;
}

// ── Guard 2: Duplicate-face / pinch prevention ───────────────────────────────
// After collapsing v2 into v1, every face of v2 that survives (i.e. does not
// share v1) gets v2 replaced by v1.  If any such remapped face is identical to
// a face already incident to v1, the collapse would create a duplicate → reject.

function hasLinkViolation(faces, vertFaces, v1, v2) {
  // Build a map of face signatures already incident to v1 (excluding shared faces).
  // Each sorted triple (a,b,c) is encoded as hi=a*0x200000+b → [c…] for zero string allocation.
  const v1Lo = new Map(); // hi → [c…]
  for (const f of vertFaces[v1]) {
    if (faces[f * 3] < 0) continue;
    let fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    if (fa === v2 || fb === v2 || fc === v2) continue;
    // Sort triple
    let t;
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    if (fb > fc) { t = fb; fb = fc; fc = t; }
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    const hi = fa * 0x200000 + fb;
    // Store hi→[lo…] mapping
    let arr = v1Lo.get(hi);
    if (!arr) { arr = []; v1Lo.set(hi, arr); }
    arr.push(fc);
  }

  for (const f of vertFaces[v2]) {
    if (faces[f * 3] < 0) continue;
    let fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    if (fa === v1 || fb === v1 || fc === v1) continue;
    // Remap v2 → v1
    if (fa === v2) fa = v1; else if (fb === v2) fb = v1; else fc = v1;
    let t;
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    if (fb > fc) { t = fb; fb = fc; fc = t; }
    if (fa > fb) { t = fa; fa = fb; fb = t; }
    const hi = fa * 0x200000 + fb;
    const arr = v1Lo.get(hi);
    if (arr) {
      for (let i = 0; i < arr.length; i++) if (arr[i] === fc) return true;
    }
  }
  return false;
}

// ── Guard 3: Normal-flip rejection ──────────────────────────────────────────
// After hypothetical collapse of v_collapse → (npx,npy,npz), recompute normals
// of all affected faces.  If any flip by more than ~78° (dot < FLIP_DOT) reject.

function checkFlipped(positions, vertFaces, faces, v_collapse, v_other, npx, npy, npz) {
  for (const f of vertFaces[v_collapse]) {
    if (faces[f * 3] < 0) continue;
    const fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    // Skip faces shared with v_other; they will be deleted on collapse
    if (fa === v_other || fb === v_other || fc === v_other) continue;

    // Original normal
    const [onx, ony, onz] = faceNormal(
      positions[fa*3], positions[fa*3+1], positions[fa*3+2],
      positions[fb*3], positions[fb*3+1], positions[fb*3+2],
      positions[fc*3], positions[fc*3+1], positions[fc*3+2]
    );

    // New normal with v_collapse replaced by new position
    const ax = fa === v_collapse ? npx : positions[fa*3];
    const ay = fa === v_collapse ? npy : positions[fa*3+1];
    const az = fa === v_collapse ? npz : positions[fa*3+2];
    const bx = fb === v_collapse ? npx : positions[fb*3];
    const by = fb === v_collapse ? npy : positions[fb*3+1];
    const bz = fb === v_collapse ? npz : positions[fb*3+2];
    const cx = fc === v_collapse ? npx : positions[fc*3];
    const cy = fc === v_collapse ? npy : positions[fc*3+1];
    const cz = fc === v_collapse ? npz : positions[fc*3+2];
    const [nnx, nny, nnz] = faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz);

    const dot = onx * nnx + ony * nny + onz * nnz;
    if (dot < FLIP_DOT) return true;
  }
  return false;
}

function faceNormal(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// ── Quadric helpers ──────────────────────────────────────────────────────────
// Symmetric 4×4 quadric stored as 10 upper-triangle values per vertex.

// ── Crease-edge quadric preservation (Garland & Heckbert §3.2) ─────────────
// For each interior edge whose two adjacent faces form a dihedral angle sharper
// than CREASE_COS, inject two penalty planes into both endpoint vertices.
// Each penalty plane is perpendicular to one adjacent face and passes through
// the crease edge, constraining the vertex to stay on the crease line.
// The high CREASE_WEIGHT ensures these edges have far higher QEM cost than
// smooth-surface edges and are therefore collapsed last (or not at all).

function addCreaseQuadrics(quadrics, positions, faces, faceCount) {
  // Build edge → [face, face] map using numeric keys (va_lo * vertMax + vb_hi)
  // vertMax = next power of two >= faceCount*3 vertices upper bound; use faceCount*3
  // as a safe upper bound since #verts ≤ #triangles*3.
  // We already have the actual vertCount from the caller but it's not passed here;
  // use a Map with numeric key = min*N + max where N = faceCount*3 (safe upper bound).
  const N = faceCount * 3;
  const edgeToFaces = new Map();
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let e = 0; e < 3; e++) {
      const va = faces[f * 3 + e];
      const vb = faces[f * 3 + ((e + 1) % 3)];
      const key = va < vb ? va * N + vb : vb * N + va;
      let arr = edgeToFaces.get(key);
      if (!arr) { arr = []; edgeToFaces.set(key, arr); }
      arr.push(f);
    }
  }

  const sqrtW = Math.sqrt(CREASE_WEIGHT);

  for (const [key, flist] of edgeToFaces) {
    if (flist.length !== 2) continue; // open boundary or non-manifold — skip

    const f0 = flist[0], f1 = flist[1];
    const v0a = faces[f0*3], v0b = faces[f0*3+1], v0c = faces[f0*3+2];
    const v1a = faces[f1*3], v1b = faces[f1*3+1], v1c = faces[f1*3+2];

    const [n0x, n0y, n0z] = faceNormal(
      positions[v0a*3], positions[v0a*3+1], positions[v0a*3+2],
      positions[v0b*3], positions[v0b*3+1], positions[v0b*3+2],
      positions[v0c*3], positions[v0c*3+1], positions[v0c*3+2]
    );
    const [n1x, n1y, n1z] = faceNormal(
      positions[v1a*3], positions[v1a*3+1], positions[v1a*3+2],
      positions[v1b*3], positions[v1b*3+1], positions[v1b*3+2],
      positions[v1c*3], positions[v1c*3+1], positions[v1c*3+2]
    );

    if (n0x*n1x + n0y*n1y + n0z*n1z >= CREASE_COS) continue; // smooth — skip

    // Resolve the two vertex indices from the numeric key
    const va = Math.floor(key / N);
    const vb = key - va * N;

    // Normalised edge direction
    const ex = positions[vb*3]   - positions[va*3];
    const ey = positions[vb*3+1] - positions[va*3+1];
    const ez = positions[vb*3+2] - positions[va*3+2];
    const elen = Math.sqrt(ex*ex + ey*ey + ez*ez) || 1;
    const edx = ex / elen, edy = ey / elen, edz = ez / elen;

    // Add one penalty plane per adjacent face-normal
    for (const [nx, ny, nz] of [[n0x, n0y, n0z], [n1x, n1y, n1z]]) {
      // Penalty plane normal = normalize(face_normal × edge_dir)
      // This plane contains the edge and is perpendicular to the face,
      // so it constrains the vertex to lie on the crease line.
      let px = ny*edz - nz*edy;
      let py = nz*edx - nx*edz;
      let pz = nx*edy - ny*edx;
      const plen = Math.sqrt(px*px + py*py + pz*pz);
      if (plen < 1e-10) continue; // edge parallel to face normal — degenerate
      px /= plen; py /= plen; pz /= plen;
      const d = -(px*positions[va*3] + py*positions[va*3+1] + pz*positions[va*3+2]);
      // Scale by sqrtW: addPlaneQ accumulates (a²,ab,…) so scaling inputs by √w yields w×(a²,ab,…)
      addPlaneQ(quadrics, va, px*sqrtW, py*sqrtW, pz*sqrtW, d*sqrtW);
      addPlaneQ(quadrics, vb, px*sqrtW, py*sqrtW, pz*sqrtW, d*sqrtW);
    }
  }
}

function initQuadrics(quadrics, positions, faces, faceCount) {
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    const fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    const [nx, ny, nz] = faceNormal(
      positions[fa*3], positions[fa*3+1], positions[fa*3+2],
      positions[fb*3], positions[fb*3+1], positions[fb*3+2],
      positions[fc*3], positions[fc*3+1], positions[fc*3+2]
    );
    const d = -(nx * positions[fa*3] + ny * positions[fa*3+1] + nz * positions[fa*3+2]);
    addPlaneQ(quadrics, fa, nx, ny, nz, d);
    addPlaneQ(quadrics, fb, nx, ny, nz, d);
    addPlaneQ(quadrics, fc, nx, ny, nz, d);
  }
}

function addPlaneQ(q, v, a, b, c, d) {
  const o = v * 10;
  q[o]   += a*a; q[o+1] += a*b; q[o+2] += a*c; q[o+3] += a*d;
                 q[o+4] += b*b; q[o+5] += b*c; q[o+6] += b*d;
                                q[o+7] += c*c; q[o+8] += c*d;
                                               q[o+9] += d*d;
}

function mergeQuadric(q, v1, v2) {
  const o1 = v1 * 10, o2 = v2 * 10;
  for (let i = 0; i < 10; i++) q[o1 + i] += q[o2 + i];
}

function evalQ(q, v, x, y, z) {
  const o = v * 10;
  return q[o]   * x*x + 2*q[o+1]*x*y + 2*q[o+2]*x*z + 2*q[o+3]*x
       + q[o+4] * y*y + 2*q[o+5]*y*z + 2*q[o+6]*y
       + q[o+7] * z*z + 2*q[o+8]*z
       + q[o+9];
}

function evalQSum(q, v1, v2, x, y, z) {
  return evalQ(q, v1, x, y, z) + evalQ(q, v2, x, y, z);
}

const _s = new Float64Array(3);

function solveQ(q, v1, v2) {
  const o1 = v1 * 10, o2 = v2 * 10;
  const a00 = q[o1]   + q[o2];
  const a01 = q[o1+1] + q[o2+1];
  const a02 = q[o1+2] + q[o2+2];
  const a11 = q[o1+4] + q[o2+4];
  const a12 = q[o1+5] + q[o2+5];
  const a22 = q[o1+7] + q[o2+7];
  const b0  = -(q[o1+3] + q[o2+3]);
  const b1  = -(q[o1+6] + q[o2+6]);
  const b2  = -(q[o1+8] + q[o2+8]);

  const det = a00*(a11*a22 - a12*a12) - a01*(a01*a22 - a12*a02) + a02*(a01*a12 - a11*a02);
  if (Math.abs(det) < 1e-10) return false;

  const inv = 1 / det;
  _s[0] = inv * (b0*(a11*a22 - a12*a12) - a01*(b1*a22 - a12*b2) + a02*(b1*a12 - a11*b2));
  _s[1] = inv * (a00*(b1*a22 - a12*b2) - b0*(a01*a22 - a12*a02) + a02*(a01*b2 - b1*a02));
  _s[2] = inv * (a00*(a11*b2 - b1*a12) - a01*(a01*b2 - b1*a02) + b0*(a01*a12 - a11*a02));
  return true;
}

function pushEdge(heap, quadrics, positions, version, v1, v2) {
  let px, py, pz;

  if (solveQ(quadrics, v1, v2)) {
    px = _s[0]; py = _s[1]; pz = _s[2];
  } else {
    const mx = (positions[v1*3]   + positions[v2*3])   / 2;
    const my = (positions[v1*3+1] + positions[v2*3+1]) / 2;
    const mz = (positions[v1*3+2] + positions[v2*3+2]) / 2;
    const e1 = evalQSum(quadrics, v1, v2, positions[v1*3],   positions[v1*3+1], positions[v1*3+2]);
    const e2 = evalQSum(quadrics, v1, v2, positions[v2*3],   positions[v2*3+1], positions[v2*3+2]);
    const em = evalQSum(quadrics, v1, v2, mx, my, mz);
    if      (e1 <= e2 && e1 <= em) { px = positions[v1*3]; py = positions[v1*3+1]; pz = positions[v1*3+2]; }
    else if (e2 <= em)             { px = positions[v2*3]; py = positions[v2*3+1]; pz = positions[v2*3+2]; }
    else                           { px = mx; py = my; pz = mz; }
  }

  const cost = evalQSum(quadrics, v1, v2, px, py, pz);
  // Snapshot both vertices' versions so the pop-side check can detect staleness
  heap.push(cost, v1, v2, version[v1], version[v2], px, py, pz);
}

// ── Indexed <-> Non-indexed conversion ──────────────────────────────────────

// Numeric spatial-hash vertex deduplication.
// Avoids template-string allocation by encoding quantised (ix,iy,iz) as a
// BigInt key: this is still fast because we only call BigInt() once per vertex.
function buildIndexed(geometry) {
  const posAttr = geometry.attributes.position;
  const n = posAttr.count;

  const positions  = new Float64Array(n * 3); // over-allocated, trimmed later
  const indexRemap = new Int32Array(n);
  let   vertCount  = 0;

  const vertMap = new Map();

  for (let i = 0; i < n; i++) {
    const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
    // Encode three 21-bit quantised integers into one BigInt key.
    // Offset by 2^20 to handle negative coordinates.
    const ix = (Math.round(x * QUANT) + 0x100000) >>> 0;
    const iy = (Math.round(y * QUANT) + 0x100000) >>> 0;
    const iz = (Math.round(z * QUANT) + 0x100000) >>> 0;
    const key = (BigInt(ix) << 42n) | (BigInt(iy) << 21n) | BigInt(iz);
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = vertCount++;
      positions[idx * 3]     = x;
      positions[idx * 3 + 1] = y;
      positions[idx * 3 + 2] = z;
      vertMap.set(key, idx);
    }
    indexRemap[i] = idx;
  }

  const faceCount = n / 3;
  const faces = new Int32Array(faceCount * 3);
  for (let i = 0; i < n; i++) faces[i] = indexRemap[i];

  return { positions: positions.subarray(0, vertCount * 3), faces, vertCount, faceCount };
}

// ── Adjacency helpers ────────────────────────────────────────────────────────

function buildAdjacency(faces, faceCount, vertCount) {
  const adj = new Array(vertCount);
  for (let v = 0; v < vertCount; v++) adj[v] = new Set();
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    adj[faces[f * 3]].add(f);
    adj[faces[f * 3 + 1]].add(f);
    adj[faces[f * 3 + 2]].add(f);
  }
  return adj;
}

function shareActiveFace(faces, vertFaces, v1, v2) {
  for (const f of vertFaces[v1]) {
    if (faces[f * 3] < 0) continue;
    const fa = faces[f * 3], fb = faces[f * 3 + 1], fc = faces[f * 3 + 2];
    if (fa === v2 || fb === v2 || fc === v2) return true;
  }
  return false;
}

function buildOutput(positions, faces, faceCount) {
  let activeFaces = 0;
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] >= 0) activeFaces++;
  }

  const posArray = new Float32Array(activeFaces * 9);
  let out = 0;
  for (let f = 0; f < faceCount; f++) {
    if (faces[f * 3] < 0) continue;
    for (let v = 0; v < 3; v++) {
      const vi = faces[f * 3 + v];
      posArray[out++] = positions[vi * 3];
      posArray[out++] = positions[vi * 3 + 1];
      posArray[out++] = positions[vi * 3 + 2];
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(posArray, 3));
  geo.computeVertexNormals();
  return geo;
}

// ── Struct-of-arrays Min-Heap ────────────────────────────────────────────────
// Stores each heap entry in parallel typed arrays rather than JS objects to
// avoid heap allocation pressure and GC pauses during the collapse loop.
// The heap is 1-indexed (root at slot 1).  Slot 0 is used as a scratch area
// by pop() so the caller can read fields after popping.
// pop() returns 0 (the scratch slot index) on success, or -1 if empty.
const SOA_GROW = 1.5;
class SoAHeap {
  constructor(initialCap = 65536) {
    let cap = 2;
    while (cap <= initialCap) cap <<= 1;
    this._cap  = cap;
    this._len  = 0;
    this._cost = new Float64Array(cap);
    this._v1   = new Int32Array(cap);
    this._v2   = new Int32Array(cap);
    this._ver1 = new Uint32Array(cap);
    this._ver2 = new Uint32Array(cap);
    this._px   = new Float64Array(cap);
    this._py   = new Float64Array(cap);
    this._pz   = new Float64Array(cap);
  }

  size() { return this._len; }

  push(cost, v1, v2, ver1, ver2, px, py, pz) {
    let i = ++this._len;
    if (i >= this._cap) this._grow();
    this._cost[i] = cost; this._v1[i] = v1; this._v2[i] = v2;
    this._ver1[i] = ver1; this._ver2[i] = ver2;
    this._px[i] = px; this._py[i] = py; this._pz[i] = pz;
    this._bubbleUp(i);
  }

  // Pops the minimum entry into slot 0 and returns 0.  Returns -1 if empty.
  pop() {
    if (this._len === 0) return -1;
    this._copySlot(0, 1);
    this._copySlot(1, this._len--);
    if (this._len > 0) this._sinkDown(1);
    return 0;
  }

  getV1  (i) { return this._v1[i]; }
  getV2  (i) { return this._v2[i]; }
  getVer1(i) { return this._ver1[i]; }
  getVer2(i) { return this._ver2[i]; }
  getPx  (i) { return this._px[i]; }
  getPy  (i) { return this._py[i]; }
  getPz  (i) { return this._pz[i]; }

  _copySlot(dst, src) {
    this._cost[dst] = this._cost[src]; this._v1[dst] = this._v1[src]; this._v2[dst] = this._v2[src];
    this._ver1[dst] = this._ver1[src]; this._ver2[dst] = this._ver2[src];
    this._px[dst]   = this._px[src];   this._py[dst]   = this._py[src];   this._pz[dst]   = this._pz[src];
  }

  _swap(a, b) {
    const tc = this._cost[a], tv1 = this._v1[a], tv2 = this._v2[a];
    const te1 = this._ver1[a], te2 = this._ver2[a];
    const tpx = this._px[a], tpy = this._py[a], tpz = this._pz[a];
    this._cost[a] = this._cost[b]; this._v1[a] = this._v1[b]; this._v2[a] = this._v2[b];
    this._ver1[a] = this._ver1[b]; this._ver2[a] = this._ver2[b];
    this._px[a]   = this._px[b];   this._py[a]   = this._py[b];   this._pz[a]   = this._pz[b];
    this._cost[b] = tc; this._v1[b] = tv1; this._v2[b] = tv2;
    this._ver1[b] = te1; this._ver2[b] = te2;
    this._px[b]   = tpx; this._py[b]   = tpy; this._pz[b]   = tpz;
  }

  _bubbleUp(i) {
    const cost = this._cost;
    while (i > 1) {
      const p = i >> 1;
      if (cost[p] <= cost[i]) break;
      this._swap(p, i); i = p;
    }
  }

  _sinkDown(i) {
    const cost = this._cost;
    const n = this._len;
    for (;;) {
      let s = i;
      const l = i << 1, r = l | 1;
      if (l <= n && cost[l] < cost[s]) s = l;
      if (r <= n && cost[r] < cost[s]) s = r;
      if (s === i) break;
      this._swap(s, i); i = s;
    }
  }

  _grow() {
    const newCap = Math.ceil(this._cap * SOA_GROW) + 2;
    const resize = (old, Ctor) => { const n = new Ctor(newCap); n.set(old); return n; };
    this._cost = resize(this._cost, Float64Array);
    this._v1   = resize(this._v1,   Int32Array);
    this._v2   = resize(this._v2,   Int32Array);
    this._ver1 = resize(this._ver1, Uint32Array);
    this._ver2 = resize(this._ver2, Uint32Array);
    this._px   = resize(this._px,   Float64Array);
    this._py   = resize(this._py,   Float64Array);
    this._pz   = resize(this._pz,   Float64Array);
    this._cap  = newCap;
  }
}
