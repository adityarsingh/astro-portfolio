#!/usr/bin/env node
/**
 * Generates WebP thumbnails for all photo albums.
 *
 * Reads from:  public/photos/{album}/*.{jpg,jpeg,png}
 * Writes to:   public/photos/{album}/thumbs/{file}.webp
 *
 * Max width: 1200px, quality: 85. Skips existing thumbs (idempotent).
 * Run manually or automatically via `npm run build`.
 */

import { readdirSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, extname, basename } from 'path';
import sharp from 'sharp';

const PHOTOS_DIR = 'public/photos';
const MAX_WIDTH   = 1200;
const QUALITY     = 85;
const SUPPORTED   = new Set(['.jpg', '.jpeg', '.png', '.webp']);

let generated = 0;
let skipped   = 0;

const albums = readdirSync(PHOTOS_DIR).filter(entry => {
  const full = join(PHOTOS_DIR, entry);
  return statSync(full).isDirectory() && entry !== 'thumbs';
});

for (const album of albums) {
  const albumDir = join(PHOTOS_DIR, album);
  const thumbDir = join(albumDir, 'thumbs');
  mkdirSync(thumbDir, { recursive: true });

  const files = readdirSync(albumDir).filter(f =>
    SUPPORTED.has(extname(f).toLowerCase()) && !statSync(join(albumDir, f)).isDirectory()
  );

  if (files.length === 0) continue;

  console.log(`\n${album} (${files.length} images)`);

  for (const file of files) {
    const nameNoExt  = basename(file, extname(file));
    const thumbPath  = join(thumbDir, `${nameNoExt}.webp`);

    if (existsSync(thumbPath)) {
      skipped++;
      continue;
    }

    try {
      const src = join(albumDir, file);
      const meta = await sharp(src).metadata();
      const width = meta.width && meta.width > MAX_WIDTH ? MAX_WIDTH : undefined;

      await sharp(src)
        .resize({ width, withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toFile(thumbPath);

      const original = statSync(src).size;
      const thumb    = statSync(thumbPath).size;
      const saving   = Math.round((1 - thumb / original) * 100);
      console.log(`  ✓ ${file} → ${nameNoExt}.webp  (${saving}% smaller)`);
      generated++;
    } catch (err) {
      console.warn(`  ✗ ${file} — ${err.message}`);
    }
  }
}

console.log(`\nDone. Generated: ${generated}, skipped (already exist): ${skipped}`);
