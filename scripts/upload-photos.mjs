#!/usr/bin/env node
/**
 * One-time migration: processes and uploads all photo albums to Linode Object Storage,
 * then rewrites the JSON content files and AboutSection.astro to use the bucket URLs.
 *
 * Usage:
 *   LINODE_BUCKET=mybucket LINODE_CLUSTER=us-east-1 \
 *   LINODE_ACCESS_KEY=xxx LINODE_SECRET_KEY=yyy \
 *   node scripts/upload-photos.mjs
 *
 * What it does:
 *   - For each album in public/photos/{album}/:
 *       generates display WebP (max 1800px) → uploads to photos/{album}/{name}.webp
 *       generates thumb  WebP (max  600px) → uploads to photos/{album}/thumbs/{name}.webp
 *   - Rewrites src/content/photos/*.json with bucket URLs + corrected dimensions
 *   - Patches the hardcoded image in src/components/AboutSection.astro
 *
 * After verifying the build works:
 *   1. Add public/photos/bramhatal public/photos/rajasthan public/photos/vietnam to .gitignore
 *   2. git rm -r --cached public/photos/bramhatal public/photos/rajasthan public/photos/vietnam
 *   3. Remove "node scripts/gen-thumbs.mjs &&" from the build script in package.json
 */

import { readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, extname, basename } from 'path';
import sharp from 'sharp';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// ── Config ────────────────────────────────────────────────────────────────────

const BUCKET     = process.env.LINODE_BUCKET;
const CLUSTER    = process.env.LINODE_CLUSTER;
const ACCESS_KEY = process.env.LINODE_ACCESS_KEY;
const SECRET_KEY = process.env.LINODE_SECRET_KEY;

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

/**
 * Process one image: generate display + thumb WebP, upload both.
 * Returns the public display URL and the actual output dimensions.
 */
async function processAndUpload(filePath, albumName, fileName) {
  const nameNoExt = basename(fileName, extname(fileName));

  const [{ data: displayBuf, info: displayInfo }, { data: thumbBuf }] =
    await Promise.all([
      sharp(filePath)
        .resize({ width: DISPLAY_W, withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true }),
      sharp(filePath)
        .resize({ width: THUMB_W, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true }),
    ]);

  const displayKey = `photos/${albumName}/${nameNoExt}.webp`;
  const thumbKey   = `photos/${albumName}/thumbs/${nameNoExt}.webp`;

  await Promise.all([
    uploadBuffer(displayKey, displayBuf, 'image/webp'),
    uploadBuffer(thumbKey,   thumbBuf,   'image/webp'),
  ]);

  return {
    url:    `${CDN_BASE}/${displayKey}`,
    width:  displayInfo.width,
    height: displayInfo.height,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

// uploadMap: "album/original-filename.jpg" → { url, width, height }
const uploadMap = new Map();

const albums = readdirSync(PHOTOS_DIR).filter(entry => {
  const full = join(PHOTOS_DIR, entry);
  return statSync(full).isDirectory() && entry !== 'thumbs';
});

console.log(`\nFound ${albums.length} album(s): ${albums.join(', ')}`);
console.log(`Uploading to: ${CDN_BASE}\n`);

for (const album of albums) {
  const albumDir = join(PHOTOS_DIR, album);
  const files = readdirSync(albumDir).filter(f => {
    const ext = extname(f).toLowerCase();
    return SUPPORTED.has(ext) && statSync(join(albumDir, f)).isFile();
  });

  console.log(`📁 ${album}  (${files.length} images)`);

  for (const file of files) {
    process.stdout.write(`   ${file} … `);
    try {
      const result = await processAndUpload(join(albumDir, file), album, file);
      uploadMap.set(`${album}/${file}`, result);
      console.log(`✓  ${result.width}×${result.height}`);
    } catch (err) {
      console.log(`✗  ${err.message}`);
    }
  }

  console.log();
}

// ── Update JSON content files ─────────────────────────────────────────────────

function resolveImageSrc(oldSrc, albumName) {
  // "/photos/bramhatal/IMG_0247-scaled.jpg" → "bramhatal/IMG_0247-scaled.jpg"
  const fileName = oldSrc.replace(/^\/photos\/[^/]+\//, '');
  return uploadMap.get(`${albumName}/${fileName}`) ?? null;
}

const jsonFiles = readdirSync(CONTENT_DIR).filter(f => f.endsWith('.json'));

for (const jsonFile of jsonFiles) {
  const albumName = jsonFile.replace('.json', '');
  const jsonPath  = join(CONTENT_DIR, jsonFile);
  const data      = JSON.parse(readFileSync(jsonPath, 'utf8'));
  let   changed   = 0;

  if (data.coverImage) {
    const mapped = resolveImageSrc(data.coverImage, albumName);
    if (mapped) { data.coverImage = mapped.url; changed++; }
  }

  if (Array.isArray(data.images)) {
    data.images = data.images.map(img => {
      const mapped = resolveImageSrc(img.src, albumName);
      if (!mapped) return img;
      changed++;
      return { ...img, src: mapped.url, width: mapped.width, height: mapped.height };
    });
  }

  writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
  console.log(`✅  Updated ${jsonFile}  (${changed} URLs)`);
}

// ── Patch AboutSection.astro hardcoded image ──────────────────────────────────

const aboutPath = 'src/components/AboutSection.astro';
const aboutKey  = 'bramhatal/bramhatal-trek-garhwal-himalayas.jpg';
const aboutImg  = uploadMap.get(aboutKey);

if (aboutImg) {
  const src     = readFileSync(aboutPath, 'utf8');
  const patched = src.replace(
    '/photos/bramhatal/bramhatal-trek-garhwal-himalayas.jpg',
    aboutImg.url,
  );
  if (patched !== src) {
    writeFileSync(aboutPath, patched);
    console.log(`✅  Updated AboutSection.astro`);
  }
} else {
  console.warn(`⚠️   bramhatal-trek-garhwal-himalayas.jpg not found in upload map — AboutSection.astro unchanged`);
}

// ── Next steps ────────────────────────────────────────────────────────────────

console.log(`
✨  Migration complete!

Next steps:
  1. Verify:  npm run build && npm run preview — check photos load from bucket
  2. Gitignore the album folders (add to .gitignore):
       public/photos/bramhatal
       public/photos/rajasthan
       public/photos/vietnam
  3. Remove from git tracking:
       git rm -r --cached public/photos/bramhatal public/photos/rajasthan public/photos/vietnam
  4. In package.json build script, remove:  node scripts/gen-thumbs.mjs &&
  5. Commit the changes
`);
