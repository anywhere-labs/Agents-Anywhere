// App icon generator.
//
// The HarmonyOS layered icon (`layered_image.json`) has exactly the same shape
// as the Android adaptive icon: a full-bleed background layer plus a foreground
// layer that the system masks. So the ports do not redraw anything:
//
//   background  <- the Android background, which is `@android:color/white`
//                  (android/app/src/main/res/drawable/ic_launcher_background.xml)
//   foreground  <- android/app/src/main/res/drawable-nodpi/ic_launcher_foreground.png,
//                  copied byte for byte, never re-encoded
//   startIcon   <- the two layers composited at the start-window size, with the
//                  same rounded corners DevEco's own template uses
//
// Reference geometry, measured from the DevEco Studio templates rather than
// guessed, because the foreground content box is what decides whether the icon
// looks correctly weighted in the launcher:
//
//   template foreground.png  1024x1024, glyph 456px  -> 44.5% of the canvas
//   template startIcon.png    144x144, corner radius 36, i.e. 25% of the side
//   Android foreground        1024x1024, glyph 511px  -> 49.9% of the canvas
//
// The Android glyph is used at its native scale: it is the original artwork,
// and 49.9% sits between the template's own 44.5% and the 67% iOS uses, so it
// reads correctly under either masking convention.
//
// Run from anywhere:  node tools/generate-app-icons.mjs
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const HARMONY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(HARMONY_ROOT, '..');
const ANDROID_FOREGROUND = join(
  REPO_ROOT, 'android/app/src/main/res/drawable-nodpi/ic_launcher_foreground.png',
);
const APP_SCOPE_MEDIA = join(HARMONY_ROOT, 'AppScope/resources/base/media');
const ENTRY_MEDIA = join(HARMONY_ROOT, 'entry/src/main/resources/base/media');

const ICON_SIZE = 1024;
const START_ICON_SIZE = 144;
const START_ICON_RADIUS = 36;
const BACKGROUND_COLOR = [0xff, 0xff, 0xff];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** Minimal 8-bit PNG reader: colour types 0, 2 and 6, no interlacing. */
function readPng(path) {
  const bytes = readFileSync(path);
  let offset = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  const idat = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('latin1');
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (depth !== 8 || (colorType !== 0 && colorType !== 2 && colorType !== 6)) {
    throw new Error(`Unsupported PNG: depth ${depth}, colour type ${colorType}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[y * stride + x - channels] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let value = line[x];
      if (filter === 1) {
        value += left;
      } else if (filter === 2) {
        value += up;
      } else if (filter === 3) {
        value += (left + up) >> 1;
      } else if (filter === 4) {
        const pa = Math.abs(up - upLeft);
        const pb = Math.abs(left - upLeft);
        const pc = Math.abs(left + up - 2 * upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function writePng(path, width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  writeFileSync(path, Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

function solidPng(width, height, [red, green, blue]) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = red;
    rgba[i * 4 + 1] = green;
    rgba[i * 4 + 2] = blue;
    rgba[i * 4 + 3] = 0xff;
  }
  return rgba;
}

/** Box-averaged coverage of the glyph in the source pixel block under one output pixel. */
function glyphCoverage(glyph, x, y, scale) {
  const x0 = Math.floor(x * scale);
  const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
  const y0 = Math.floor(y * scale);
  const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
  let total = 0;
  let count = 0;
  for (let sy = y0; sy < y1; sy++) {
    for (let sx = x0; sx < x1; sx++) {
      const index = (sy * glyph.width + sx) * glyph.channels + (glyph.channels - 1);
      total += glyph.channels === 4 ? glyph.data[index] : 0xff;
      count++;
    }
  }
  return count === 0 ? 0 : total / count;
}

/** Fraction of a 4x4 sub-sample grid inside the rounded rect, for antialiased corners. */
function roundedRectCoverage(x, y, size, radius) {
  const steps = 4;
  let inside = 0;
  for (let sy = 0; sy < steps; sy++) {
    for (let sx = 0; sx < steps; sx++) {
      const px = x + (sx + 0.5) / steps;
      const py = y + (sy + 0.5) / steps;
      const nearX = Math.min(Math.max(px, radius), size - radius);
      const nearY = Math.min(Math.max(py, radius), size - radius);
      const dx = px - nearX;
      const dy = py - nearY;
      if (dx * dx + dy * dy <= radius * radius) {
        inside++;
      }
    }
  }
  return inside / (steps * steps);
}

/**
 * The start window icon, matching DevEco's template: the composited icon at
 * 144px with baked rounded corners, the glyph carried over at the same relative
 * size it has in the launcher icon.
 */
function buildStartIcon(glyph) {
  const scale = glyph.width / START_ICON_SIZE;
  const rgba = Buffer.alloc(START_ICON_SIZE * START_ICON_SIZE * 4);
  for (let y = 0; y < START_ICON_SIZE; y++) {
    for (let x = 0; x < START_ICON_SIZE; x++) {
      const coverage = glyphCoverage(glyph, x, y, scale) / 255;
      const corners = roundedRectCoverage(x, y, START_ICON_SIZE, START_ICON_RADIUS);
      const index = (y * START_ICON_SIZE + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        rgba[index + channel] = Math.round(BACKGROUND_COLOR[channel] * (1 - coverage));
      }
      rgba[index + 3] = Math.round(corners * 255);
    }
  }
  return rgba;
}

function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16);
}

const glyph = readPng(ANDROID_FOREGROUND);
if (glyph.width !== ICON_SIZE || glyph.height !== ICON_SIZE) {
  throw new Error(`Foreground must be ${ICON_SIZE}x${ICON_SIZE}, got ${glyph.width}x${glyph.height}`);
}

for (const media of [APP_SCOPE_MEDIA, ENTRY_MEDIA]) {
  mkdirSync(media, { recursive: true });
  writePng(join(media, 'background.png'), ICON_SIZE, ICON_SIZE,
    solidPng(ICON_SIZE, ICON_SIZE, BACKGROUND_COLOR));
  copyFileSync(ANDROID_FOREGROUND, join(media, 'foreground.png'));
}
writePng(join(ENTRY_MEDIA, 'startIcon.png'), START_ICON_SIZE, START_ICON_SIZE, buildStartIcon(glyph));

console.log(`background.png  ${ICON_SIZE}x${ICON_SIZE} solid #FFFFFF`);
console.log(`foreground.png  ${ICON_SIZE}x${ICON_SIZE} copied from ic_launcher_foreground.png`);
console.log(`startIcon.png   ${START_ICON_SIZE}x${START_ICON_SIZE} radius ${START_ICON_RADIUS}`);
console.log(`foreground digest ${digest(ANDROID_FOREGROUND)} (android) / `
  + `${digest(join(APP_SCOPE_MEDIA, 'foreground.png'))} (AppScope) / `
  + `${digest(join(ENTRY_MEDIA, 'foreground.png'))} (entry)`);
