// Generates icons/*.png with no dependencies. Run: node tools/make-icons.js [size] [outDir]
// Design: Heimdall's crescent-horned golden helm with his sword Hofund standing
// behind it, blade rising between the horns, on a night-sky tile.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, '..', 'icons');

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, sum]);
};

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const clamp01 = (t) => Math.min(1, Math.max(0, t));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * clamp01(t));

const SKY_TOP = hex('#0a1028');
const SKY_BOTTOM = hex('#2b2266');
const GOLD_LIGHT = hex('#ffe699');
const GOLD = hex('#f2b53a');
const GOLD_DARK = hex('#9a5c14');
const SHADOW = hex('#1a1006');
const STEEL_LIGHT = hex('#f1f6fc');
const STEEL_DARK = hex('#7f93b0');
const LEATHER = hex('#5a2f17');
const STARS = [[0.82, 0.16, 0.012], [0.12, 0.3, 0.01], [0.9, 0.5, 0.009], [0.16, 0.7, 0.009], [0.7, 0.9, 0.008]];

const RAD = 180 / Math.PI;

function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = d(px, py, ax, ay, bx, by);
  const d2 = d(px, py, bx, by, cx, cy);
  const d3 = d(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

// Art is drawn in a 0..1 box centered on the tile and scaled down to leave a margin.
const ART_SCALE = 0.9;

function art(u, v, thick, color) {
  const x = 0.5 + (u - 0.5) / ART_SCALE; // art space
  const y = 0.5 + (v - 0.5) / ART_SCALE;
  const dx = x - 0.5;
  const adx = Math.abs(dx);

  // Crescent horns: a ring around (0.5, 0.36), thick at the base, pointed at the tips.
  {
    const rho = Math.hypot(dx, y - 0.36);
    const phi = Math.atan2(y - 0.36, dx) * RAD;
    const a = Math.abs(((phi - 90 + 540) % 360) - 180); // 0 at the bottom of the ring
    if (a <= 148) {
      const h = (0.01 + 0.055 * (1 - (a / 152) ** 2)) * thick;
      const s = (rho - 0.26) / h;
      if (Math.abs(s) <= 1) color = mix(mix(GOLD_LIGHT, GOLD_DARK, (s + 1) / 2), GOLD, 0.3);
    }
  }

  // Hofund, the sword, behind the helm: blade, then guard, grip, pommel below.
  {
    const tip = 0.06;
    const half = 0.026 * thick;
    const taper = y < 0.17 ? clamp01((y - tip) / (0.17 - tip)) : 1;
    if (y >= tip && y <= 0.82 && adx <= half * taper) {
      const edge = adx / (half * taper);
      color = mix(dx < 0 ? STEEL_LIGHT : mix(STEEL_LIGHT, STEEL_DARK, 0.55), STEEL_DARK, edge ** 3);
      if (adx < 0.004 * thick) color = mix(color, [255, 255, 255], 0.6);
    }
  }

  // Helm dome and face plate.
  {
    const ex = dx / 0.15;
    const ey = (y - 0.55) / 0.13;
    const dome = y <= 0.58 && ex * ex + ey * ey <= 1;
    const face = y > 0.55 && y <= 0.72 && adx <= 0.15 - (y - 0.55) * 0.26;
    if (dome || face) {
      const lit = clamp01(0.5 + (-dx * 1.6 - (y - 0.55) * 1.2));
      color = mix(mix(GOLD_DARK, GOLD, 0.6), GOLD_LIGHT, lit * 0.9);
    }
    // Cheek blades hanging down like fangs.
    const fang = inTriangle(adx, y, [0.06, 0.66], [0.13, 0.69], [0.1, 0.8]);
    if (fang) color = mix(GOLD, GOLD_DARK, 0.35 + (adx - 0.06) * 3);
    if (dome || face || fang) {
      // Visor slit with a nose guard down the middle.
      const slitY = 0.595 + adx * 0.12;
      if (adx <= 0.115 && Math.abs(y - slitY) <= 0.02) color = SHADOW;
      if (y > 0.64 && y <= 0.72 && adx < 0.055 - (y - 0.64) * 0.2) color = SHADOW;
      if (adx <= 0.014 && y >= 0.53 && y <= 0.72) color = mix(GOLD_LIGHT, GOLD, 0.35);
      // Brow ridge.
      if (y >= 0.535 && y <= 0.55 && adx < 0.14) color = mix(color, GOLD_LIGHT, 0.5);
    }
  }

  // Crossguard, grip, pommel.
  if (y >= 0.8 && y <= 0.83 && adx <= 0.115) {
    color = mix(GOLD_LIGHT, GOLD_DARK, (y - 0.8) / 0.03);
  }
  if (y > 0.83 && y <= 0.9 && adx <= 0.017 * thick) {
    color = mix(LEATHER, SHADOW, (Math.sin(y * 260) + 1) / 5);
  }
  if (Math.hypot(dx, y - 0.925) <= 0.034 * Math.min(thick, 1.2)) color = mix(GOLD_LIGHT, GOLD_DARK, (y - 0.9) / 0.05);
  return color;
}

function shade(u, v, size) {
  const x = u - 0.5;
  const y = v - 0.5;

  // Rounded-square tile.
  const corner = 0.22;
  const ax = Math.abs(x) - (0.5 - corner);
  const ay = Math.abs(y) - (0.5 - corner);
  if (Math.hypot(Math.max(ax, 0), Math.max(ay, 0)) > corner) return null;

  let color = mix(SKY_TOP, SKY_BOTTOM, v * 1.1);

  // Gold border, only where it is wide enough to read.
  if (size >= 48) {
    const inset = 0.045;
    const bx = Math.abs(x) - (0.5 - inset - (corner - inset));
    const by = Math.abs(y) - (0.5 - inset - (corner - inset));
    const d = Math.hypot(Math.max(bx, 0), Math.max(by, 0)) - (corner - inset);
    if (Math.abs(d) < 0.011) color = mix(GOLD_DARK, GOLD, 0.6);
  }
  for (const [sx, sy, sr] of STARS) if (Math.hypot(u - sx, v - sy) < sr) color = mix(color, [255, 255, 255], 0.85);

  return art(u, v, size <= 32 ? 1.5 : 1, color);
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const ss = 4; // 4x4 supersampling
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = shade((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size, size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; a += 1;
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? r / a : 0;
      raw[o + 1] = a ? g / a : 0;
      raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const sizes = process.argv[2] ? [Number(process.argv[2])] : [16, 32, 48, 128];
const target = process.argv[3] || outDir;
fs.mkdirSync(target, { recursive: true });
for (const size of sizes) fs.writeFileSync(path.join(target, `${size}.png`), png(size));
