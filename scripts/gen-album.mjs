#!/usr/bin/env node
/**
 * Photo album JSON generator.
 *
 * Scans a folder of images and writes the content collection JSON file.
 *
 * Usage:
 *   node scripts/gen-album.mjs \
 *     --folder  ./public/photos/rajasthan \
 *     --id      rajasthan \
 *     --title   "Rajasthan" \
 *     --desc    "Colours, forts, and the desert." \
 *     --location "Rajasthan, India" \
 *     --date    "2023-03-01"
 *
 * Output: src/content/photos/rajasthan.json
 *
 * The first image in the folder (alphabetically) becomes the cover.
 * Supported formats: jpg, jpeg, png, webp, avif, gif
 */

import { readdirSync, writeFileSync, existsSync } from 'fs';
import { join, extname, basename } from 'path';
import sharp from 'sharp';

const args = process.argv.slice(2);
function getArg(name) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 ? args[i + 1] : null;
}

const folder   = getArg('folder');
const id       = getArg('id');
const title    = getArg('title');
const desc     = getArg('desc');
const location = getArg('location');
const date     = getArg('date');

if (!folder || !id || !title || !desc || !location || !date) {
  console.error(`
Usage: node scripts/gen-album.mjs \\
  --folder   ./public/photos/rajasthan \\
  --id       rajasthan \\
  --title    "Rajasthan" \\
  --desc     "Short description" \\
  --location "Rajasthan, India" \\
  --date     "2023-03-01"
  `);
  process.exit(1);
}

if (!existsSync(folder)) {
  console.error(`Folder not found: ${folder}`);
  process.exit(1);
}

const SUPPORTED = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif']);

const files = readdirSync(folder)
  .filter(f => SUPPORTED.has(extname(f).toLowerCase()))
  .sort(); // alphabetical — rename files to control order

if (files.length === 0) {
  console.error(`No supported images found in ${folder}`);
  process.exit(1);
}

console.log(`Found ${files.length} images in ${folder}`);
console.log('Reading dimensions (this may take a moment)...\n');

const images = [];
for (const file of files) {
  const fullPath = join(folder, file);
  try {
    const meta = await sharp(fullPath).metadata();
    const src  = `/photos/${id}/${file}`;
    images.push({
      src,
      alt:    basename(file, extname(file)).replace(/[-_]/g, ' '),
      width:  meta.width  ?? 0,
      height: meta.height ?? 0,
    });
    console.log(`  ✓ ${file}  (${meta.width}×${meta.height})`);
  } catch (err) {
    console.warn(`  ✗ ${file} — skipped (${err.message})`);
  }
}

const cover = images[0];
const output = {
  title,
  description: desc,
  date,
  coverImage: cover.src,
  coverAlt:   cover.alt,
  location,
  images,
};

const outPath = `src/content/photos/${id}.json`;
writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
console.log(`\nWritten → ${outPath}  (${images.length} images)`);

// Generate WebP thumbnails for this album
console.log('\nGenerating WebP thumbnails...');
const { execSync } = await import('child_process');
execSync(`node scripts/gen-thumbs.mjs`, { stdio: 'inherit' });
