/**
 * Generates build/icon.png (1024x1024) with no image dependencies.
 * electron-builder derives .ico and .icns from it on each platform.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const SS = 3; // supersampling factor

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgba, width, height) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(qx, 0);
  const oy = Math.max(qy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r;
}

function sdSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = clamp((wx * vx + wy * vy) / (vx * vx + vy * vy), 0, 1);
  const dx = wx - vx * t;
  const dy = wy - vy * t;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Returns [r,g,b,a] 0..255 for a point in 0..1 space. */
function shade(x, y) {
  const margin = 0.055;
  const d = sdRoundRect(x, y, 0.5, 0.5, 0.5 - margin, 0.5 - margin, 0.235);

  // Soft drop shadow behind the plate.
  const shadow = clamp(1 - Math.max(0, sdRoundRect(x, y - 0.012, 0.5, 0.5, 0.5 - margin, 0.5 - margin, 0.235)) * 26, 0, 1);
  if (d > 0.002) {
    const a = 0.34 * shadow * shadow;
    return [0, 0, 0, a * 255];
  }

  // Plate: vertical gradient.
  const t = clamp((y - margin) / (1 - margin * 2), 0, 1);
  let r = mix(26, 8, t);
  let g = mix(28, 9, t);
  let b = mix(34, 11, t);

  // Top inner highlight.
  const hl = clamp(1 - Math.abs(y - (margin + 0.012)) / 0.02, 0, 1) * (1 - Math.abs(x - 0.5) / 0.42);
  r += hl * 26;
  g += hl * 28;
  b += hl * 34;

  // "V" mark.
  const w = 0.072;
  const l1 = sdSegment(x, y, 0.315, 0.305, 0.5, 0.705) - w;
  const l2 = sdSegment(x, y, 0.685, 0.305, 0.5, 0.705) - w;
  const vd = Math.min(l1, l2);
  const va = clamp(0.5 - vd * SIZE * 0.5, 0, 1);

  if (va > 0) {
    const k = clamp((y - 0.3) / 0.42, 0, 1);
    const vr = mix(255, 138, k);
    const vg = mix(255, 170, k);
    const vb = mix(255, 255, k);
    r = mix(r, vr, va);
    g = mix(g, vg, va);
    b = mix(b, vb, va);
  }

  // Accent underscore under the V.
  const bar = sdRoundRect(x, y, 0.5, 0.795, 0.135, 0.019, 0.019);
  const ba = clamp(0.5 - bar * SIZE * 0.5, 0, 1);
  if (ba > 0) {
    const k = clamp((x - 0.36) / 0.28, 0, 1);
    r = mix(r, mix(59, 118, k), ba);
    g = mix(g, mix(92, 152, k), ba);
    b = mix(b, mix(246, 255, k), ba);
  }

  return [r, g, b, 255];
}

function render() {
  const out = Buffer.alloc(SIZE * SIZE * 4);
  const inv = 1 / SIZE;
  const n = SS * SS;
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = shade((px + (sx + 0.5) / SS) * inv, (py + (sy + 0.5) / SS) * inv);
          const ca = c[3] / 255;
          r += c[0] * ca;
          g += c[1] * ca;
          b += c[2] * ca;
          a += c[3] / 255;
        }
      }
      a /= n;
      const idx = (py * SIZE + px) * 4;
      if (a <= 0.0005) {
        out[idx] = 0;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 0;
      } else {
        out[idx] = clamp(Math.round(r / n / a), 0, 255);
        out[idx + 1] = clamp(Math.round(g / n / a), 0, 255);
        out[idx + 2] = clamp(Math.round(b / n / a), 0, 255);
        out[idx + 3] = clamp(Math.round(a * 255), 0, 255);
      }
    }
  }
  return out;
}

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });
const png = encodePng(render(), SIZE, SIZE);
fs.writeFileSync(path.join(buildDir, 'icon.png'), png);
console.log('wrote build/icon.png (' + Math.round(png.length / 1024) + ' KB)');
