// tools/gen-tray-icon.js — 生成系统托盘图标（无外部依赖，手写 PNG 编码）
//
// 为什么要自己生成：项目没有图标资源，而 Tray 必须拿到一张真实图片。
// 这里用纯 Node（zlib）画一个和界面主题色一致的方块机器人脸：
//   src/assets/tray.png     16x16（Windows 100% DPI）
//   src/assets/tray@2x.png  32x32（HiDPI，nativeImage 会自动配对 @2x）
// 改颜色/形状后重跑：node tools/gen-tray-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x25, 0x63, 0xeb]; // #2563eb，与 style.css 的 --accent-dark 一致
const FG = [0xff, 0xff, 0xff];
const SS = 4; // 每像素 4x4 超采样，用于边缘抗锯齿

// 几何定义都按 32 网格写，输出时按 SIZE/32 缩放
const G = {
  box: { x0: 1, y0: 1, x1: 31, y1: 31, r: 7 },
  eyes: [
    { cx: 11.5, cy: 13.5, r: 2.8 },
    { cx: 20.5, cy: 13.5, r: 2.8 },
  ],
  mouth: { x0: 11, y0: 20.5, x1: 21, y1: 23.5, r: 1.2 },
};

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// PNG 编码需要的 CRC32 表
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function renderPNG(size) {
  const k = size / 32; // 缩放系数
  const b = G.box;
  const box = { x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k, r: b.r * k };
  const eyes = G.eyes.map((e) => ({ cx: e.cx * k, cy: e.cy * k, r: e.r * k }));
  const m = G.mouth;
  const mouth = { x0: m.x0 * k, y0: m.y0 * k, x1: m.x1 * k, y1: m.y1 * k, r: m.r * k };

  const raw = Buffer.alloc((size * 4 + 1) * size);
  const total = SS * SS;
  for (let py = 0; py < size; py++) {
    const rowStart = py * (size * 4 + 1);
    raw[rowStart] = 0; // PNG 行过滤器：none
    for (let px = 0; px < size; px++) {
      let cov = 0;
      let r = 0;
      let g = 0;
      let bl = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          if (!inRoundedRect(x, y, box.x0, box.y0, box.x1, box.y1, box.r)) continue;
          cov++;
          const face =
            eyes.some((e) => inCircle(x, y, e.cx, e.cy, e.r)) ||
            inRoundedRect(x, y, mouth.x0, mouth.y0, mouth.x1, mouth.y1, mouth.r);
          const c = face ? FG : BG;
          r += c[0];
          g += c[1];
          bl += c[2];
        }
      }
      const o = rowStart + 1 + px * 4;
      raw[o] = cov ? Math.round(r / cov) : 0;
      raw[o + 1] = cov ? Math.round(g / cov) : 0;
      raw[o + 2] = cov ? Math.round(bl / cov) : 0;
      raw[o + 3] = Math.round((cov / total) * 255);
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'src', 'assets');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [['tray.png', 16], ['tray@2x.png', 32]]) {
  const png = renderPNG(size);
  fs.writeFileSync(path.join(outDir, name), png);
  console.log(`written ${name} (${size}x${size}, ${png.length} bytes)`);
}
