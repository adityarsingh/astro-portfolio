#!/usr/bin/env node
/**
 * upload-photos.mjs
 *
 * Ongoing workflow tool for adding photos to existing albums or creating new ones.
 * Safe to run repeatedly — skips already-uploaded files and preserves alt text/captions.
 *
 * ── Adding photos to an existing album ─────────────────────────────────────────
 *   1. Drop new photos into public/photos/{album}/
 *   2. node scripts/upload-photos.mjs
 *      (or: ALBUM=rajasthan node scripts/upload-photos.mjs  ← only process one album)
 *   3. New entries are appended to src/content/photos/{album}.json
 *   4. Edit the JSON to add proper alt text / captions for the new photos
 *   5. git add src/content/photos/{album}.json && git commit && git push
 *
 * ── Creating a new album ────────────────────────────────────────────────────────
 *   1. mkdir public/photos/{new-album} and drop photos in it
 *   2. node scripts/upload-photos.mjs
 *   3. A starter src/content/photos/{new-album}.json is created — fill in title,
 *      description, date, location, and alt text for each image
 *   4. git add src/content/photos/{new-album}.json && git commit && git push
 *
 * ── Env vars ────────────────────────────────────────────────────────────────────
 *   Required: LINODE_BUCKET  LINODE_CLUSTER  LINODE_ACCESS_KEY  LINODE_SECRET_KEY
 *   Optional: ALBUM=name   — only process this one album (faster)
 *
 * ── What it uploads ─────────────────────────────────────────────────────────────
 *   Display WebP  (max 1800px wide, quality 85) → photos/{album}/{name}.webp
 *   Thumbnail WebP (max  600px wide, quality 80) → photos/{album}/thumbs/{name}.webp
 */

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join, extname, basename } from 'path';
import sharp from 'sharp';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

// Auto-load .env file if it exists (Node 20.6+ built-in)
if (existsSync('.env')) {
  const envFile = readFileSync('.env', 'utf8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}

// ── Config ────────────────────────────────────────────────────────────────────

const BUCKET     = process.env.LINODE_BUCKET;
const CLUSTER    = process.env.LINODE_CLUSTER;
const ACCESS_KEY = process.env.LINODE_ACCESS_KEY;
const SECRET_KEY = process.env.LINODE_SECRET_KEY;
const ONLY_ALBUM = process.env.ALBUM ?? null; // optional: process just one album
const FORCE      = process.env.FORCE === 'true'; // re-upload even if already in bucket

if (!BUCKET || !CLUSTER || !ACCESS_KEY || !SECRET_KEY) {
  console.error(
    '\nMissing required env vars.\n' +
    'Set: LINODE_BUCKET  LINODE_CLUSTER  LINODE_ACCESS_KEY  LINODE_SECRET_KEY\n'
  );
  process.exit(1);
}

const CDN_BASE    = `https://${BUCKET}.${CLUSTER}.linodeobjects.com`;
const PHOTOS_DIR  = 'public/photos';
const CONTENT_DIR = 'src/content/photos';
const DISPLAY_W   = 1800;
const THUMB_W     = 600;
const SUPPORTED   = new Set(['.jpg', '.jpeg', '.png']);

// ── S3 client ─────────────────────────────────────────────────────────────────

const s3 = new S3Client({
  region: CLUSTER,
  endpoint: `https://${CLUSTER}.linodeobjects.com`,
  credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY },
  forcePathStyle: false,
});

async function alreadyUploaded(key) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function uploadBuffer(key, buf, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType,
    ACL: 'public-read',
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

// ── Image processing + upload ─────────────────────────────────────────────────

async function processAndUpload(filePath, albumName, fileName) {
  const nameNoExt  = basename(fileName, extname(fileName));
  const displayKey = `photos/${albumName}/${nameNoExt}.webp`;
  const thumbKey   = `photos/${albumName}/thumbs/${nameNoExt}.webp`;

  // Skip if both versions already exist in the bucket (unless FORCE=true)
  if (!FORCE) {
    const [displayExists, thumbExists] = await Promise.all([
      alreadyUploaded(displayKey),
      alreadyUploaded(thumbKey),
    ]);

    if (displayExists && thumbExists) {
      // Still need dimensions — read from local file without re-uploading
      const meta = await sharp(filePath)
        .rotate()                                          // respect EXIF orientation
        .resize({ width: DISPLAY_W, withoutEnlargement: true })
        .toBuffer({ resolveWithObject: true });
      return { url: `${CDN_BASE}/${displayKey}`, width: meta.info.width, height: meta.info.height, skipped: true };
    }
  }

  const [{ data: displayBuf, info: displayInfo }, { data: thumbBuf }] =
    await Promise.all([
      sharp(filePath)
        .rotate()                                          // respect EXIF orientation
        .resize({ width: DISPLAY_W, withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true }),
      sharp(filePath)
        .rotate()                                          // respect EXIF orientation
        .resize({ width: THUMB_W, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true }),
    ]);

  await Promise.all([
    uploadBuffer(displayKey, displayBuf, 'image/webp'),
    uploadBuffer(thumbKey,   thumbBuf,   'image/webp'),
  ]);

  return { url: `${CDN_BASE}/${displayKey}`, width: displayInfo.width, height: displayInfo.height, skipped: false };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadJson(jsonPath) {
  if (!existsSync(jsonPath)) return null;
  return JSON.parse(readFileSync(jsonPath, 'utf8'));
}

function isBucketUrl(src) {
  return src && src.startsWith('https://');
}

// Extract the base filename (without ext) from either a local path or bucket URL
function baseNameFromSrc(src) {
  const file = src.split('/').pop();               // "DSC00363.JPG" or "DSC00363.webp"
  return file.replace(/\.[^.]+$/, '');              // "DSC00363"
}

// ── Main ──────────────────────────────────────────────────────────────────────

let albums = readdirSync(PHOTOS_DIR).filter(entry => {
  const full = join(PHOTOS_DIR, entry);
  return statSync(full).isDirectory() && entry !== 'thumbs';
});

if (ONLY_ALBUM) {
  if (!albums.includes(ONLY_ALBUM)) {
    console.error(`\nAlbum "${ONLY_ALBUM}" not found in ${PHOTOS_DIR}/\n`);
    process.exit(1);
  }
  albums = [ONLY_ALBUM];
}

console.log(`\nFound ${albums.length} album(s): ${albums.join(', ')}`);
console.log(`Bucket: ${CDN_BASE}\n`);

for (const album of albums) {
  const albumDir  = join(PHOTOS_DIR, album);
  const jsonPath  = join(CONTENT_DIR, `${album}.json`);
  const isNew     = !existsSync(jsonPath);

  const files = readdirSync(albumDir).filter(f => {
    const ext = extname(f).toLowerCase();
    return SUPPORTED.has(ext) && statSync(join(albumDir, f)).isFile();
  });

  if (files.length === 0) {
    console.log(`📁 ${album}  — no images found, skipping\n`);
    continue;
  }

  // Build set of base filenames already in the JSON so we don't re-add them
  const existingData   = loadJson(jsonPath);
  const existingImages = existingData?.images ?? [];
  const existingBases  = new Set(existingImages.map(img => baseNameFromSrc(img.src)));

  console.log(`📁 ${album}  (${files.length} images${isNew ? ' — NEW ALBUM' : ''})`);

  const newEntries = [];

  for (const file of files) {
    const nameNoExt = basename(file, extname(file));

    const alreadyInJson = existingBases.has(nameNoExt);

    // Skip entirely if already in JSON and not forcing a re-upload
    if (alreadyInJson && !FORCE) {
      console.log(`   ${file}  — already in JSON, skipping`);
      continue;
    }

    process.stdout.write(`   ${file} … `);
    try {
      const result = await processAndUpload(join(albumDir, file), album, file);
      const label  = result.skipped ? '(already in bucket)' : '✓ uploaded';
      console.log(`${label}  ${result.width}×${result.height}`);

      // Only add a new JSON entry if the image isn't already listed
      if (!alreadyInJson) {
        newEntries.push({
          src:    result.url,
          alt:    `${album.charAt(0).toUpperCase() + album.slice(1)}`,  // placeholder — edit this!
          width:  result.width,
          height: result.height,
        });
      }
    } catch (err) {
      console.log(`✗  ${err.message}`);
    }
  }

  if (newEntries.length === 0) {
    console.log(`   Nothing new to add.\n`);
    continue;
  }

  // ── Write / update JSON ───────────────────────────────────────────────────

  if (isNew) {
    // Brand new album — create a starter JSON with placeholder metadata
    const firstEntry = newEntries[0];
    const starter = {
      title:       `${album.charAt(0).toUpperCase() + album.slice(1)}`,
      description: 'Add a description here.',
      date:        new Date().toISOString().split('T')[0],
      coverImage:  firstEntry.src,
      coverAlt:    'Add cover alt text here.',
      location:    'Add location here.',
      images:      newEntries,
    };
    writeFileSync(jsonPath, JSON.stringify(starter, null, 2) + '\n');
    console.log(`\n✅  Created ${album}.json with ${newEntries.length} image(s)`);
    console.log(`   ⚠️  Edit src/content/photos/${album}.json to add title, description, location, and alt text!\n`);
  } else {
    // Existing album — append new entries, preserve everything else
    existingData.images = [...existingImages, ...newEntries];
    writeFileSync(jsonPath, JSON.stringify(existingData, null, 2) + '\n');
    console.log(`\n✅  Appended ${newEntries.length} new image(s) to ${album}.json`);
    console.log(`   ⚠️  Edit src/content/photos/${album}.json to add alt text for the new photos!\n`);
  }
}

console.log(`
Done! Next steps:
  1. Edit the JSON file(s) above to fill in alt text, captions, descriptions
  2. npm run build  — verify everything looks right
  3. git add src/content/photos/  &&  git commit  &&  git push
`);
