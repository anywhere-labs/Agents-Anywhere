// App icon generator.
//
// The HarmonyOS layered icon (`layered_image.json`) has exactly the same shape
// as the Android adaptive icon: a full-bleed background layer plus a foreground
// layer that the system masks. The artwork is the **iOS app icon**
// (`ios/Agents Anywhere/…/Assets.xcassets/AppIcon.appiconset/ios-dark-iOS-Dark-1024@1x.png`,
// the asset the iOS app itself uses for its default appearance), because the
// launcher icon is what the user compares against the iOS client:
//
//   background  <- that icon's own background colour, sampled inside its tile
//   foreground  <- that icon's glyph, un-composited off the background as white
//                  with an alpha channel
//   startIcon   <- the two layers composited at the start-window size, with the
//                  same rounded corners DevEco's own template uses
//
// The iOS asset is a rounded-square tile on transparency: its corners are the
// launcher's business, not the artwork's, so they are not carried over — the
// background is a flat fill and the system applies the HarmonyOS mask.
//
// Reference geometry, measured from the DevEco Studio templates rather than
// guessed, because the foreground content box is what decides whether the icon
// looks correctly weighted in the launcher:
//
//   template startIcon.png    144x144, corner radius 36, i.e. 25% of the side
//   iOS glyph                 ~66% of the canvas, which is exactly the share the
//                             layered-icon safe zone is designed for
//
// Run from anywhere:  node tools/generate-app-icons.mjs
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const HARMONY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(HARMONY_ROOT, '..');
const IOS_ICON = join(
  REPO_ROOT,
  'ios/Agents Anywhere/Agents Anywhere/Assets.xcassets/AppIcon.appiconset/ios-dark-iOS-Dark-1024@1x.png',
);
const APP_SCOPE_MEDIA = join(HARMONY_ROOT, 'AppScope/resources/base/media');
const ENTRY_MEDIA = join(HARMONY_ROOT, 'entry/src/main/resources/base/media');

const ICON_SIZE = 1024;
const START_ICON_SIZE = 144;
const START_ICON_RADIUS = 36;

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

/**
 * Minimal PNG reader: colour types 0, 2, 4 and 6 at 8 or 16 bits per sample.
 *
 * The iOS icon asset is 16-bit RGBA, so 16-bit samples are reduced to their high
 * byte — the icon is a flat tile and a glyph, which 8 bits per channel carry
 * without a visible difference.
 */
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
  const supported = colorType === 0 || colorType === 2 || colorType === 4 || colorType === 6;
  if ((depth !== 8 && depth !== 16) || !supported) {
    throw new Error(`Unsupported PNG: depth ${depth}, colour type ${colorType}`);
  }
  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : 1;
  const sampleBytes = depth === 16 ? 2 : 1;
  const pixelBytes = channels * sampleBytes;
  const stride = width * pixelBytes;
  const raw = inflateSync(Buffer.concat(idat));
  const filtered = Buffer.alloc(height * stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= pixelBytes ? filtered[y * stride + x - pixelBytes] : 0;
      const up = y > 0 ? filtered[(y - 1) * stride + x] : 0;
      const upLeft = x >= pixelBytes && y > 0 ? filtered[(y - 1) * stride + x - pixelBytes] : 0;
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
      filtered[y * stride + x] = value & 0xff;
    }
  }
  if (sampleBytes === 1) {
    return { width, height, channels, data: filtered };
  }
  const data = Buffer.alloc(width * height * channels);
  for (let i = 0; i < width * height * channels; i += 1) {
    data[i] = filtered[i * 2];
  }
  return { width, height, channels, data };
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
 * Splits the iOS tile into its background colour and its glyph.
 *
 * The asset is a light glyph over a near-black tile, so the glyph's coverage is
 * `(pixel - background) / (glyph - background)` on the green channel, and the
 * glyph's own value is the brightest one the tile carries. Everything the tile
 * leaves transparent is background too, which is why the tile's rounded corners
 * disappear here.
 */
function splitTile(tile) {
  const { width, height, channels, data } = tile;
  const green = (x, y) => data[(y * width + x) * channels + (channels >= 3 ? 1 : 0)];
  const alpha = (x, y) => (channels === 4 ? data[(y * width + x) * channels + 3] : 255);
  // The tile's own rounded corners are transparent, so the colour is read from the
  // first opaque row just inside the top edge, which the glyph never reaches.
  let top = 0;
  while (top < height && alpha(Math.floor(width / 2), top) < 250) {
    top += 1;
  }
  const background = green(Math.floor(width / 2), Math.min(top + 12, height - 1));
  let brightest = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      if (alpha(x, y) > 8) {
        brightest = Math.max(brightest, green(x, y));
      }
    }
  }
  // The iOS tile carries a light inner outline a couple of percent in from its
  // own rounded corners; nothing but the glyph lives inside the middle 84%, so
  // everything outside that box is dropped along with it.
  const inset = Math.round(width * 0.08);
  const glyph = Buffer.alloc(width * height * 4);
  let glyphPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const source = (y * width + x) * channels;
      const opacity = alpha(x, y) / 255;
      const value = green(x, y);
      const coverage = brightest > background
        ? Math.min(Math.max((value - background) / (brightest - background), 0), 1) : 0;
      const inside = x >= inset && x < width - inset && y >= inset && y < height - inset;
      // A faint anti-aliased edge should not survive as a grey halo, so the first
      // half of the range is dropped rather than merely clipped.
      const shaped = !inside || coverage <= 0.5 ? 0 : (coverage - 0.5) / 0.5;
      glyph[index] = 0xff;
      glyph[index + 1] = 0xff;
      glyph[index + 2] = 0xff;
      glyph[index + 3] = Math.round(shaped * opacity * 255);
      if (glyph[index + 3] > 128) {
        glyphPixels += 1;
      }
    }
  }
  console.log(`tile background ${background}, glyph peak ${brightest}, `
    + `${glyphPixels} glyph pixels (${(glyphPixels / (width * height) * 100).toFixed(1)}%)`);
  return { background, glyph: { width, height, data: glyph } };
}

/** The start window icon: the two layers composited with baked rounded corners. */
function buildStartIcon(background, glyph) {
  const scale = glyph.width / START_ICON_SIZE;
  const rgba = Buffer.alloc(START_ICON_SIZE * START_ICON_SIZE * 4);
  for (let y = 0; y < START_ICON_SIZE; y++) {
    for (let x = 0; x < START_ICON_SIZE; x++) {
      const corners = roundedRectCoverage(x, y, START_ICON_SIZE, START_ICON_RADIUS);
      const index = (y * START_ICON_SIZE + x) * 4;
      let coverage = 0;
      let samples = 0;
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      const y0 = Math.floor(y * scale);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          coverage += glyph.data[(sy * glyph.width + sx) * 4 + 3];
          samples += 1;
        }
      }
      const glyphOpacity = samples === 0 ? 0 : coverage / samples / 255;
      for (let channel = 0; channel < 3; channel++) {
        rgba[index + channel] = Math.round(
          background * (1 - glyphOpacity) + 0xff * glyphOpacity,
        );
      }
      rgba[index + 3] = Math.round(corners * 255);
    }
  }
  return rgba;
}

const tile = readPng(IOS_ICON);
if (tile.width !== ICON_SIZE || tile.height !== ICON_SIZE) {
  throw new Error(`Icon must be ${ICON_SIZE}x${ICON_SIZE}, got ${tile.width}x${tile.height}`);
}
const { background, glyph } = splitTile(tile);

for (const media of [APP_SCOPE_MEDIA, ENTRY_MEDIA]) {
  mkdirSync(media, { recursive: true });
  const solid = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
  for (let i = 0; i < ICON_SIZE * ICON_SIZE; i += 1) {
    solid[i * 4] = background;
    solid[i * 4 + 1] = background;
    solid[i * 4 + 2] = background;
    solid[i * 4 + 3] = 0xff;
  }
  writePng(join(media, 'background.png'), ICON_SIZE, ICON_SIZE, solid);
  writePng(join(media, 'foreground.png'), ICON_SIZE, ICON_SIZE, glyph.data);
}
const startIcon = buildStartIcon(background, glyph);
let startGlyph = 0;
for (let i = 0; i < START_ICON_SIZE * START_ICON_SIZE; i += 1) {
  if (startIcon[i * 4] > 160 && startIcon[i * 4 + 3] > 128) {
    startGlyph += 1;
  }
}
writePng(join(ENTRY_MEDIA, 'startIcon.png'), START_ICON_SIZE, START_ICON_SIZE, startIcon);
console.log(`background.png  ${ICON_SIZE}x${ICON_SIZE} solid rgb(${background},${background},${background})`);
console.log(`foreground.png  ${ICON_SIZE}x${ICON_SIZE} white glyph split off the iOS tile`);
console.log(`startIcon.png   ${START_ICON_SIZE}x${START_ICON_SIZE} radius ${START_ICON_RADIUS}, `
  + `${startGlyph} glyph pixels`);
