/**
 * Downloads all photo album images from WordPress URLs to /public/photos/{album}/
 * and rewrites src paths in the JSON files to local /photos/{album}/{file} paths.
 *
 * Safe to re-run: skips files that already exist on disk.
 * Usage: node scripts/download-photos.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT_DIR = join(ROOT, 'src/content/photos');
const PUBLIC_DIR = join(ROOT, 'public/photos');
const ALBUMS = ['bramhatal', 'vietnam', 'rajasthan', 'nepal'];
const CONCURRENCY = 6;

async function downloadFile(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  writeFileSync(dest, Buffer.from(buf));
}

async function runBatch(tasks) {
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    await Promise.all(tasks.slice(i, i + CONCURRENCY).map(t => t()));
  }
}

async function processAlbum(albumName) {
  const jsonPath = join(CONTENT_DIR, `${albumName}.json`);
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const dir = join(PUBLIC_DIR, albumName);
  mkdirSync(dir, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // Collect all URLs to process: coverImage + every image src
  const urlFields = [
    { obj: data, key: 'coverImage' },
    ...data.images.map((img, i) => ({ obj: data.images[i], key: 'src' })),
  ];

  // Deduplicate by URL so the same file isn't fetched twice
  const seen = new Set();
  const tasks = urlFields
    .filter(({ obj, key }) => {
      const url = obj[key];
      if (!url.startsWith('http')) return false;
      if (seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .map(({ obj, key }) => async () => {
      const url = obj[key];
      const filename = basename(url);
      const dest = join(dir, filename);
      const localPath = `/photos/${albumName}/${filename}`;

      if (existsSync(dest)) {
        obj[key] = localPath;
        skipped++;
        return;
      }

      try {
        process.stdout.write(`  ↓ ${filename}\n`);
        await downloadFile(url, dest);
        obj[key] = localPath;
        downloaded++;
      } catch (err) {
        console.error(`  ✗ FAILED ${filename}: ${err.message}`);
        failed++;
      }
    });

  // Also patch any remaining http references (e.g. coverImage that shares a src URL)
  // by running a second pass after downloads complete
  await runBatch(tasks);

  // Second pass: update any fields whose URL was downloaded by a different task
  for (const { obj, key } of urlFields) {
    if (obj[key].startsWith('http')) {
      const filename = basename(obj[key]);
      const dest = join(dir, filename);
      if (existsSync(dest)) {
        obj[key] = `/photos/${albumName}/${filename}`;
      }
    }
  }

  writeFileSync(jsonPath, JSON.stringify(data, null, 2) + '\n');
  console.log(
    `  ✓ ${albumName}: ${downloaded} downloaded, ${skipped} already existed, ${failed} failed`,
  );
  return { downloaded, skipped, failed };
}

async function main() {
  let total = { downloaded: 0, skipped: 0, failed: 0 };

  for (const album of ALBUMS) {
    console.log(`\n[ ${album} ]`);
    const stats = await processAlbum(album);
    total.downloaded += stats.downloaded;
    total.skipped += stats.skipped;
    total.failed += stats.failed;
  }

  console.log(
    `\nDone — ${total.downloaded} downloaded, ${total.skipped} skipped, ${total.failed} failed.`,
  );
  if (total.failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
