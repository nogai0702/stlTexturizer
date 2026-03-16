import * as THREE from 'three';

const SIZE = 512; // texture resolution for both preview and sampling

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeCanvas(size = SIZE) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function grayPixel(value255) {
  return `rgb(${value255},${value255},${value255})`;
}

// Simple seeded LCG pseudo-random number generator (deterministic)
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

// ── Generators ───────────────────────────────────────────────────────────────

/** Horizontal sine waves */
function generateWaves(size = SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(size, size);
  const d = id.data;
  for (let y = 0; y < size; y++) {
    const v = Math.sin((y / size) * Math.PI * 10) * 0.5 + 0.5;
    const g = Math.round(v * 255);
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      d[i] = d[i+1] = d[i+2] = g;
      d[i+3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

/** Fish-scale / overlapping circles */
function generateScales(size = SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);

  const r = size / 8;
  const rStroke = r * 0.08;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = rStroke;
  ctx.fillStyle = '#333';

  const rows = Math.ceil(size / r) + 2;
  const cols = Math.ceil(size / r) + 2;
  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      const ox = col * r * 1.0 + (row % 2 === 0 ? 0 : r * 0.5);
      const oy = row * r * 0.75;
      ctx.beginPath();
      ctx.arc(ox, oy, r * 0.92, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
  }
  return canvas;
}

/** Hexagonal grid */
function generateHex(size = SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#222';
  ctx.fillRect(0, 0, size, size);

  const r = size / 8;
  const w = Math.sqrt(3) * r;
  const h = 2 * r;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = r * 0.12;

  function hexPath(cx, cy) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      const px = cx + r * 0.88 * Math.cos(angle);
      const py = cy + r * 0.88 * Math.sin(angle);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  const cols = Math.ceil(size / w) + 2;
  const rows = Math.ceil(size / (h * 0.75)) + 2;
  for (let row = -1; row < rows; row++) {
    for (let col = -1; col < cols; col++) {
      const cx = col * w + (row % 2 === 0 ? 0 : w / 2);
      const cy = row * h * 0.75;
      hexPath(cx, cy);
      ctx.fillStyle = `hsl(0,0%,${20 + Math.random() * 10}%)`;
      ctx.fill();
      ctx.stroke();
    }
  }
  return canvas;
}

/** Diamond / crosshatch */
function generateDiamonds(size = SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(size, size);
  const d = id.data;
  const freq = 8;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const val = (Math.abs(Math.sin(u * Math.PI * freq)) +
                   Math.abs(Math.sin(v * Math.PI * freq))) / 2;
      const g = Math.round(val * 255);
      const i = (y * size + x) * 4;
      d[i] = d[i+1] = d[i+2] = g;
      d[i+3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

/** Smooth noise (value noise via bilinear interpolation of random grid) */
function generateNoise(size = SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  const id = ctx.createImageData(size, size);
  const d = id.data;
  const rand = lcg(0xdeadbeef);

  // Generate random value grid at coarser resolution
  const GRID = 16;
  const grid = new Float32Array((GRID + 1) * (GRID + 1));
  for (let i = 0; i < grid.length; i++) grid[i] = rand();

  function bilerp(gx, gy) {
    const x0 = Math.floor(gx) % GRID;
    const y0 = Math.floor(gy) % GRID;
    const x1 = (x0 + 1) % GRID;
    const y1 = (y0 + 1) % GRID;
    const fx = gx - Math.floor(gx);
    const fy = gy - Math.floor(gy);
    // Smoothstep
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const v00 = grid[y0 * (GRID+1) + x0];
    const v10 = grid[y0 * (GRID+1) + x1];
    const v01 = grid[y1 * (GRID+1) + x0];
    const v11 = grid[y1 * (GRID+1) + x1];
    return v00 + sx * (v10 - v00) + sy * (v01 - v00) + sx * sy * (v00 - v10 - v01 + v11);
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * GRID;
      const gy = (y / size) * GRID;
      // Octave 1 + octave 2
      let v = bilerp(gx, gy) * 0.65 + bilerp(gx * 2, gy * 2) * 0.25 + bilerp(gx * 4, gy * 4) * 0.10;
      const g = Math.round(Math.max(0, Math.min(1, v)) * 255);
      const i4 = (y * size + x) * 4;
      d[i4] = d[i4+1] = d[i4+2] = g;
      d[i4+3] = 255;
    }
  }
  ctx.putImageData(id, 0, 0);
  return canvas;
}

/** Brick pattern */
function generateBrick(size = SIZE) {
  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#555';
  ctx.fillRect(0, 0, size, size);

  const bw = size / 5;  // brick width
  const bh = size / 10; // brick height
  const mortar = bw * 0.07;

  ctx.fillStyle = '#ddd';
  const rows = Math.ceil(size / bh) + 1;
  const cols = Math.ceil(size / bw) + 2;
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2 === 0 ? 0 : bw * 0.5);
    for (let col = -1; col < cols; col++) {
      const x = col * bw + offset + mortar / 2;
      const y = row * bh + mortar / 2;
      ctx.fillRect(x, y, bw - mortar, bh - mortar);
    }
  }
  return canvas;
}

// ── Build PRESETS array ───────────────────────────────────────────────────────

const GENERATORS = [
  { name: 'Waves',     gen: generateWaves },
  { name: 'Scales',    gen: generateScales },
  { name: 'Hexagonal', gen: generateHex },
  { name: 'Diamonds',  gen: generateDiamonds },
  { name: 'Noise',     gen: generateNoise },
  { name: 'Brick',     gen: generateBrick },
];

export const PRESETS = GENERATORS.map(({ name, gen }) => {
  const fullCanvas   = gen(SIZE);
  const thumbCanvas  = gen(80);     // small canvas for swatch UI
  const texture      = new THREE.CanvasTexture(fullCanvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.name = name;

  // Extract ImageData for CPU sampling
  const ctx = fullCanvas.getContext('2d');
  const imageData = ctx.getImageData(0, 0, SIZE, SIZE);

  return { name, thumbCanvas, fullCanvas, texture, imageData, width: SIZE, height: SIZE };
});

/**
 * Build a THREE.CanvasTexture + ImageData from a user-uploaded image File.
 */
export function loadCustomTexture(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = makeCanvas(SIZE);
      const ctx    = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, SIZE, SIZE);
      const imageData = ctx.getImageData(0, 0, SIZE, SIZE);
      const texture   = new THREE.CanvasTexture(canvas);
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.name = file.name;
      resolve({ name: file.name, fullCanvas: canvas, texture, imageData, width: SIZE, height: SIZE });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Failed to load image')); };
    img.src = url;
  });
}
