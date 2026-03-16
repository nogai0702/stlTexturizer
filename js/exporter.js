import * as THREE from 'three';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';

const exporter = new STLExporter();

/**
 * Export a BufferGeometry as a binary STL file download.
 *
 * @param {THREE.BufferGeometry} geometry
 * @param {string} [filename]
 */
export function exportSTL(geometry, filename = 'textured.stl') {
  // The geometry was rotated -90° around X on load to convert Z-up → Y-up for the viewer.
  // Undo that rotation before export so the STL lands back in the original Z-up orientation
  // that 3D-print slicers expect.
  const exportGeom = geometry.clone();
  exportGeom.applyMatrix4(new THREE.Matrix4().makeRotationX(Math.PI / 2));

  const mesh = new THREE.Mesh(exportGeom, new THREE.MeshBasicMaterial());
  const result = exporter.parse(mesh, { binary: true });
  exportGeom.dispose();

  // result is an ArrayBuffer in binary mode
  const blob = new Blob([result], { type: 'application/octet-stream' });
  const url  = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Revoke after a short delay so the download has time to start
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
